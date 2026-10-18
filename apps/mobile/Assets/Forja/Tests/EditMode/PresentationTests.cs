using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Forja.Application;
using Forja.Core;
using Forja.Presentation;
using UnityEngine;
using NUnit.Framework;
using UnityEngine.UIElements;

namespace Forja.Tests
{
    public sealed class PresentationTests
    {
        [Test] public void SensitiveTransitionsResetNavigationAndMasking()
        {
            var navigation = new ShellNavigation();
            navigation.Go(ShellDestination.Work); navigation.ToggleValues(); navigation.SelectCharacter("female");
            navigation.SessionChanged(SessionState.AUTHENTICATED, true);
            Assert.That(navigation.Destination, Is.EqualTo(ShellDestination.Work));
            navigation.SessionChanged(SessionState.BOOTSTRAPPING, false);
            Assert.That(navigation.Destination, Is.EqualTo(ShellDestination.Home));
            Assert.That(navigation.HiddenValues, Is.True); Assert.That(navigation.CharacterId, Is.Null);
        }
        [Test] public void MaskedGoalNeverPlacesAmountsInLabelsOrTooltips()
        {
            var goal = new GoalView { Title = "test goal", State = "Ativa", Target = "BRL 999,00", Credited = "BRL 12,00", Remaining = "BRL 987,00" };
            var panel = ShellComponents.Goal(goal, true);
            Assert.That(panel.Query<Label>().ToList().Count(x => x.text == "••••"), Is.EqualTo(3));
            Assert.That(panel.Query<Label>().ToList().Any(x => x.text.Contains("BRL") || (x.tooltip ?? "").Contains("BRL")), Is.False);
        }
        [TestCase(FinancialMeaning.Settled, "realizado")]
        [TestCase(FinancialMeaning.Projected, "estimativa")]
        [TestCase(FinancialMeaning.Receivable, "não recebido")]
        [TestCase(FinancialMeaning.Payable, "não pago")]
        [TestCase(FinancialMeaning.GoalFunding, "realizados")]
        [TestCase(FinancialMeaning.WorkCapacity, "estimativa")]
        public void SemanticsUseWordsRatherThanOnlyColor(FinancialMeaning meaning, string required)
        { Assert.That(FinancialLabels.Title(meaning), Does.Contain(required)); }
        [Test] public async Task AuthenticatedNavigationAndLogoutRemovePrivateHierarchy()
        {
            var api = new Api();
            using (var session = new SessionCoordinator(api, new Store(), new Browser(), new MobileSettings("development", "https://api.example.test", "", "", "com.darlan.forja.dev:/auth/callback")))
            {
                await session.Start();
                var root = new VisualElement(); var navigation = new ShellNavigation();
                var shell = new ForjaShell(root, navigation, _ => {}, () => {}, _ => {});
                shell.Render(session, false);
                Assert.That(root.Query<Label>().ToList().Any(x => x.text == "private fixture account"), Is.True);
                navigation.Go(ShellDestination.Goals); shell.Render(session, false);
                Assert.That(root.Query<Label>().ToList().Any(x => x.text == "Você ainda não tem metas cadastradas."), Is.True);
                navigation.Go(ShellDestination.Reports); shell.Render(session, false);
                Assert.That(root.Query<Label>().ToList().Any(x => x.text.Contains("Nenhuma crônica nesta página")), Is.True);
                await session.Logout(); shell.Render(session, false);
                Assert.That(session.Snapshot, Is.Null);
                Assert.That(root.Query<Label>().ToList().Any(x => x.text.Contains("private fixture")), Is.False);
                Assert.That(navigation.HiddenValues, Is.True);
            }
        }
        [Test] public void ActualCatalogueHasEqualNonReadableBounded2DTextures()
        {
            var art = Resources.Load<PresentationArt>("UI/PresentationArt");
            Assert.That(art, Is.Not.Null);
            var textures = new[] { art.world, art.male.neutral, art.female.neutral };
            long bytes = 0;
            foreach (var texture in textures)
            {
                Assert.That(texture, Is.Not.Null); Assert.That(texture.isReadable, Is.False);
                Assert.That(Math.Max(texture.width, texture.height), Is.LessThanOrEqualTo(1024));
                bytes += (long)texture.width * texture.height * 4;
            }
            Assert.That(art.male.neutral.width, Is.EqualTo(art.female.neutral.width));
            Assert.That(art.male.neutral.height, Is.EqualTo(art.female.neutral.height));
            Assert.That(bytes, Is.LessThanOrEqualTo(10 * 1024 * 1024));
        }
        [Test] public async Task MissionCommandsReadServerXpAndRepeatedRenderShowsOneRewardThenClearsOnBackground()
        {
            var api = new Api();
            using (var session = new SessionCoordinator(api, new Store(), new Browser(), new MobileSettings("development", "https://api.example.test", "", "", "com.darlan.forja.dev:/auth/callback")))
            {
                await session.Start();
                api.ServerXp = 70; api.Completed = true;
                await session.AssignMission(new MissionCandidate { Template = "WORK_PROFILE" });
                Assert.That(session.Snapshot.Game.Xp, Is.EqualTo(70));
                Assert.That(Guid.TryParseExact(api.AssignmentKey, "D", out _), Is.True);
                var root = new VisualElement(); var navigation = new ShellNavigation(); navigation.Go(ShellDestination.Missions);
                var shell = new ForjaShell(root, navigation, _ => {}, () => {}, _ => {});
                for (int i = 0; i < 3; i++)
                {
                    shell.Render(session, false);
                    Assert.That(root.Query<Label>().ToList().Count(x => x.text == "Concluída · XP creditado uma vez"), Is.EqualTo(1));
                    Assert.That(session.Snapshot.Game.Xp, Is.EqualTo(70));
                }
                session.Background(); shell.Render(session, false);
                Assert.That(session.Snapshot, Is.Null);
                Assert.That(root.Query<Label>().ToList().Any(x => x.text.Contains("XP creditado")), Is.False);
            }
        }
        [Test] public async Task ChronicleDetailIsServerOwnedAndClearedOnBackground()
        {
            using (var session = new SessionCoordinator(new Api(), new Store(), new Browser(), Settings()))
            {
                await session.Start(); await session.OpenChronicle("test-report");
                Assert.That(session.Chronicle.Realized[0].Value, Is.EqualTo("BRL 987,65"));
                var root = new VisualElement(); var navigation = new ShellNavigation();
                var shell = new ForjaShell(root, navigation, _ => {}, () => {}, _ => {});
                navigation.Go(ShellDestination.Reports); shell.Render(session, false);
                Assert.That(Text(root), Does.Not.Contain("987,65"));
                navigation.ToggleValues(); shell.Render(session, false); Assert.That(Text(root), Does.Contain("987,65"));
                session.Background(); shell.Render(session, false); Assert.That(session.Chronicle, Is.Null); Assert.That(Text(root), Does.Not.Contain("987,65"));
            }
        }
        [Test] public async Task ChronicleOfflineFailureKeepsAuthenticatedShellAndShowsNoStaleDetail()
        {
            var api = new Api();
            using (var session = new SessionCoordinator(api, new Store(), new Browser(), Settings()))
            {
                await session.Start(); await session.OpenChronicle("test-report"); api.ReportOffline = true;
                await session.OpenChronicle("test-report");
                Assert.That(session.State, Is.EqualTo(SessionState.AUTHENTICATED)); Assert.That(session.Snapshot, Is.Not.Null);
                Assert.That(session.Chronicle, Is.Null); Assert.That(session.ChronicleError, Is.EqualTo(Failure.Offline));
            }
        }
        private static MobileSettings Settings() => new MobileSettings("development", "https://api.example.test", "", "", "com.darlan.forja.dev:/auth/callback");
        private static string Text(VisualElement root) => string.Join(" ", root.Query<Label>().ToList().Select(x => x.text));
        private sealed class Api : IBackendApi
        {
            public long ServerXp = 20; public bool Completed; public string AssignmentKey;
            public Task<ChronicleView> CreateChronicle(string a, ChronicleRequest r, string k, CancellationToken c) => throw new NotSupportedException();
            public bool ReportOffline;
            public Task<ChronicleView> ReadChronicle(string a, string id, CancellationToken c)
            {
                if (ReportOffline) throw new MobileFailure(Failure.Offline);
                var result = new ChronicleView { Item = new ChronicleItem { Id = id, Type = "DAILY", Generation = 1, From = "2026-03-08", Through = "2026-03-08" }, Timezone = "UTC" };
                result.Realized.Add(new ChronicleLine { Label = "Receitas realizadas", Value = "BRL 987,65" }); return Task.FromResult(result);
            }
            public Task<ChroniclePage> ReadChronicles(string a, int after, CancellationToken c) => throw new NotSupportedException();
            public Task AssignMission(string a, MissionCandidate m, string k, CancellationToken c) { AssignmentKey = k; return Task.CompletedTask; }
            public Task EvaluateMission(string a, string id, bool cancel, CancellationToken c) => throw new NotSupportedException();

            public Task Ready(CancellationToken c) => Task.CompletedTask;
            public Task<Tokens> Refresh(string r, CancellationToken c) => Task.FromResult(new Tokens { Access = new string('a',43), Refresh = new string('b',43), ExpiresIn = 300 });
            public Task<ShellSnapshot> Read(string a, CancellationToken c)
            { var result = new ShellSnapshot { Name = "private fixture name", ReportToday = "2026-10-17", ReportTimezone = "UTC", Chronicles = new ChroniclePage() }; result.Game = new GameView { Xp = ServerXp, Level = 1, NextLevelXp = 100, XpToNextLevel = 30 };
                if (Completed) result.Game.History.Add(new MissionView { Id = "test mission", Title = "test completed mission", Description = "test objective", State = "COMPLETED", RewardXp = 50, Current = "Perfil confirmado", Target = "Confirmar perfil", Reconciliation = "UNCHANGED", ExpiresAt = "2026-11-05T12:00:00.000Z" });
                result.Accounts.Add(new AccountView { Name = "private fixture account", State = "active", Balance = "BRL 123,45" }); return Task.FromResult(result); }
            public Task Revoke(string a, bool all, CancellationToken c) => Task.CompletedTask;
            public Task<AuthChallenge> Begin(string a,string i,CancellationToken c) => throw new NotSupportedException();
            public Task<Tokens> Complete(AuthChallenge a,string v,string code,CancellationToken c) => throw new NotSupportedException();
        }
        private sealed class Store : ISessionCredentialStore
        {
            private string value = new string('r',43);
            public Task<string> ReadAsync(CancellationToken c) => Task.FromResult(value);
            public Task WriteAsync(string v,CancellationToken c) { value=v;return Task.CompletedTask; }
            public Task DeleteAsync(CancellationToken c) { value=null;return Task.CompletedTask; }
        }
        private sealed class Browser : IAuthorizationBrowser
        { public Task<string> Authorize(string a,string s,CancellationToken c) => throw new NotSupportedException(); public void Cancel() {} }
    }
}
