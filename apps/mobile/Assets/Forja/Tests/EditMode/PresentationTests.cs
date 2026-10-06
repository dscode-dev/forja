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
                Assert.That(root.Query<Label>().ToList().Any(x => x.text.Contains("relatórios ainda não estão disponíveis")), Is.True);
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
        private sealed class Api : IBackendApi
        {
            public Task Ready(CancellationToken c) => Task.CompletedTask;
            public Task<Tokens> Refresh(string r, CancellationToken c) => Task.FromResult(new Tokens { Access = new string('a',43), Refresh = new string('b',43), ExpiresIn = 300 });
            public Task<ShellSnapshot> Read(string a, CancellationToken c)
            { var result = new ShellSnapshot { Name = "private fixture name" }; result.Accounts.Add(new AccountView { Name = "private fixture account", State = "active", Balance = "BRL 123,45" }); return Task.FromResult(result); }
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
