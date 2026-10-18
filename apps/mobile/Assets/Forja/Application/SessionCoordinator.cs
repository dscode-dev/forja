using System;
using System.Threading;
using System.Threading.Tasks;
using Forja.Core;

namespace Forja.Application
{
    public sealed class SessionCoordinator : IDisposable
    {
        private readonly IBackendApi api;
        private readonly ISessionCredentialStore store;
        private readonly IAuthorizationBrowser browser;
        private readonly MobileSettings settings;
        private readonly Func<DateTimeOffset> now;
        private CancellationTokenSource lifetime = new CancellationTokenSource();
        private readonly SemaphoreSlim renewalGate = new SemaphoreSlim(1, 1);
        private string access;
        private DateTimeOffset expires;
        private bool busy, suspended, disposed, browserPending;
        private int generation;
        public SessionState State { get; private set; } = SessionState.BOOTSTRAPPING;
        public ShellSnapshot Snapshot { get; private set; }
        public ChronicleView Chronicle { get; private set; }
        public Failure? ChronicleError { get; private set; }
        public AiPreferences AiPreferences { get; private set; }
        public AiAnalysis AiAnalysis { get; private set; }
        public bool AiBusy { get; private set; }
        public Failure? AiError { get; private set; }
        private int aiGeneration;
        private void ClearAi() { aiGeneration++; AiPreferences = null; AiAnalysis = null; AiError = null; AiBusy = false; }
        public Failure? Error { get; private set; }
        public bool Busy => busy;
        public bool CanLogin => settings.OidcConfigured;
        public event Action Changed;
        public SessionCoordinator(IBackendApi api, ISessionCredentialStore store, IAuthorizationBrowser browser, MobileSettings settings, Func<DateTimeOffset> clock = null)
        { this.api = api; this.store = store; this.browser = browser; this.settings = settings; now = clock ?? (() => DateTimeOffset.UtcNow); }
        private void Set(SessionState state, Failure? error = null)
        { State = state; Error = error; Changed?.Invoke(); }
        private void ResetMemory()
        { generation++; ClearAi(); lifetime.Cancel(); lifetime.Dispose(); lifetime = new CancellationTokenSource(); access = null; Snapshot = null; Chronicle = null; ChronicleError = null; }
        private void Check(int epoch)
        { if (epoch != generation || disposed || suspended) throw new OperationCanceledException(); }
        public Task Start() => Run(async () =>
        {
            Set(SessionState.BOOTSTRAPPING);
            int epoch = generation;
            await api.Ready(lifetime.Token); Check(epoch);
            if (await store.ReadAsync(lifetime.Token) == null) { Check(epoch); Set(SessionState.UNAUTHENTICATED); return; }
            await Renew(); await Load();
        });
        public Task Login(string intent)
        {
            if (busy || disposed) return Task.CompletedTask;
            ResetMemory();
            return Run(async () =>
        {
            if (!CanLogin) throw new MobileFailure(Failure.Unavailable);
            await store.DeleteAsync(lifetime.Token);
            Set(SessionState.AUTHENTICATING);
            int epoch = generation;
            string verifier = Pkce.Verifier();
            var challenge = await api.Begin(Pkce.Challenge(verifier), intent, lifetime.Token);
            Check(epoch);
            var deadline = now().AddSeconds(challenge.ExpiresIn);
            Pkce.Authorization(challenge, settings, verifier);
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
            {
                timeout.CancelAfter(TimeSpan.FromSeconds(challenge.ExpiresIn));
                string callback;
                browserPending = true;
                try { callback = await browser.Authorize(challenge.AuthorizationUrl, "com.darlan.forja.dev", timeout.Token); }
                finally { browserPending = false; }
                Check(epoch);
                if (now() >= deadline) throw new MobileFailure(Failure.Unauthorized);
                var tokens = await api.Complete(challenge, verifier, Pkce.Code(callback, settings.Redirect, challenge.State), lifetime.Token);
                Check(epoch); await Accept(tokens, epoch); await Load();
            }
        });
        }
        private async Task Accept(Tokens tokens, int epoch)
        {
            tokens.Validate(); Check(epoch);
            await store.WriteAsync(tokens.Refresh, lifetime.Token); Check(epoch);
            access = tokens.Access; expires = now().AddSeconds(tokens.ExpiresIn - 15);
        }
        private async Task Renew()
        {
            int epoch = generation;
            await renewalGate.WaitAsync(lifetime.Token);
            try
            {
                Check(epoch);
                if (access != null && now() < expires) return;
                string credential = await store.ReadAsync(lifetime.Token);
                if (credential == null) throw new MobileFailure(Failure.Unauthorized);
                // Remove the old credential before transmission: a process crash cannot replay it.
                await store.DeleteAsync(lifetime.Token); Check(epoch);
                var tokens = await api.Refresh(credential, lifetime.Token);
                Check(epoch); await Accept(tokens, epoch);
            }
            catch
            {
                if (epoch == generation) { access = null; Snapshot = null; await store.DeleteAsync(CancellationToken.None); }
                throw;
            }
            finally { renewalGate.Release(); }
        }
        private async Task Load()
        {
            int epoch = generation;
            if (access == null || now() >= expires) await Renew();
            ShellSnapshot result;
            try { result = await api.Read(access, lifetime.Token); }
            catch (MobileFailure failure) when (failure.Kind == Failure.Unauthorized)
            {
                Snapshot = null; access = null; await Renew();
                result = await api.Read(access, lifetime.Token);
            }
            Check(epoch); ClearAi(); Chronicle = null; Snapshot = result; Set(SessionState.AUTHENTICATED);
        }
        public Task Reload() => Run(Load);
        private Task RunChronicle(Func<Task> action) => Run(async () =>
        {
            int epoch = generation; ClearAi(); ChronicleError = null;
            try { await action(); }
            catch (MobileFailure failure) when (failure.Kind == Failure.Offline || failure.Kind == Failure.Timeout || failure.Kind == Failure.Unavailable || failure.Kind == Failure.InvalidPeriod || failure.Kind == Failure.ChronicleExpired)
            { Check(epoch); Chronicle = null; ChronicleError = failure.Kind; Set(SessionState.AUTHENTICATED); }
        });
        public Task CreateChronicle(ChronicleRequest request) => RunChronicle(async () =>
        {
            int epoch = generation; Chronicle = null;
            await Renew(); Check(epoch);
            var result = await api.CreateChronicle(access, request, Guid.NewGuid().ToString("D"), lifetime.Token);
            Check(epoch); await Load(); Check(epoch); Chronicle = result;
        });
        public Task OpenChronicle(string id) => RunChronicle(async () =>
        {
            int epoch = generation; Chronicle = null;
            await Renew(); Check(epoch);
            var result = await api.ReadChronicle(access, id, lifetime.Token);
            Check(epoch); Chronicle = result; Set(SessionState.AUTHENTICATED);
        });
        public Task MoreChronicles() => RunChronicle(async () =>
        {
            if (Snapshot?.Chronicles?.Next == null) return;
            int epoch = generation, after = Snapshot.Chronicles.Next.Value;
            await Renew(); Check(epoch);
            var result = await api.ReadChronicles(access, after, lifetime.Token);
            Check(epoch); Snapshot.Chronicles = result; Chronicle = null; Set(SessionState.AUTHENTICATED);
        });
        // AI has an independent loading/failure surface; deterministic report remains visible.
        public async Task RefreshAi() => await RunAi(async (report, epoch) =>
        {
            var preference = await api.ReadAiPreferences(access, lifetime.Token);
            if (epoch != aiGeneration) return;
            AiPreferences = preference;
            var result = await api.ReadAlquimista(access, report, lifetime.Token);
            if (epoch == aiGeneration) AiAnalysis = result;
        });
        public Task ConsentAi(bool enabled) => RunAi(async (report, epoch) =>
        {
            if (AiPreferences == null) throw new MobileFailure(Failure.Unavailable);
            var result = await api.SetAiPreferences(access, AiPreferences, enabled, lifetime.Token);
            if (epoch != aiGeneration) return;
            AiPreferences = result; AiAnalysis = null; // Enabling never dispatches inference.
        });
        public Task Analyze(bool retry = false) => RunAi(async (report, epoch) =>
        {
            if (AiPreferences?.Enabled != true || !AiPreferences.ProviderAvailable) return;
            string retryOf = retry && AiAnalysis?.State == "FAILED" ? AiAnalysis.ExecutionId : null;
            var result = await api.RequestAlquimista(access, report, Guid.NewGuid().ToString("D"), retryOf, lifetime.Token);
            if (epoch == aiGeneration) AiAnalysis = result;
        });
        private async Task RunAi(Func<string, int, Task> action)
        {
            if (disposed || suspended || busy || AiBusy || State != SessionState.AUTHENTICATED || Chronicle == null) return;
            int epoch = generation, aiEpoch = aiGeneration; string report = Chronicle.Item.Id;
            AiBusy = true; AiError = null; Changed?.Invoke();
            try { await Renew(); Check(epoch); if (aiEpoch == aiGeneration) await action(report, aiEpoch); }
            catch (OperationCanceledException) { }
            catch (MobileFailure failure)
            {
                if (epoch != generation || aiEpoch != aiGeneration || suspended || disposed) return;
                AiError = failure.Kind;
                if (failure.Kind == Failure.Unauthorized)
                { ResetMemory(); await store.DeleteAsync(CancellationToken.None); Set(SessionState.SESSION_EXPIRED, failure.Kind); }
            }
            catch { if (epoch == generation && aiEpoch == aiGeneration) AiError = Failure.Unavailable; }
            finally { if (epoch == generation && aiEpoch == aiGeneration) AiBusy = false; Changed?.Invoke(); }
        }
        public Task AssignMission(MissionCandidate candidate) => Run(async () =>
        {
            int epoch = generation;
            await Renew(); Check(epoch);
            await api.AssignMission(access, candidate, Guid.NewGuid().ToString("D"), lifetime.Token);
            Check(epoch); await Load();
        });
        public Task EvaluateMission(string id, bool cancel = false) => Run(async () =>
        {
            int epoch = generation;
            await Renew(); Check(epoch);
            await api.EvaluateMission(access, id, cancel, lifetime.Token);
            Check(epoch); await Load();
        });
        public Task Logout(bool all = false) => Run(async () =>
        {
            string token = access;
            // Revoke-all needs fresh OIDC proof; a denied request must retain this session.
            if (all)
            {
                if (token == null) throw new MobileFailure(Failure.Unauthorized);
                await api.Revoke(token, true, lifetime.Token);
            }
            ResetMemory(); browser.Cancel(); busy = false;
            try { await store.DeleteAsync(CancellationToken.None); }
            catch { Set(SessionState.FATAL_CONFIGURATION_ERROR, Failure.Configuration); return; }
            Set(SessionState.UNAUTHENTICATED);
            int logoutEpoch = generation;
            if (!all && token != null)
            {
                try { await api.Revoke(token, false, lifetime.Token); }
                catch { if (generation == logoutEpoch) { Error = Failure.Unavailable; Changed?.Invoke(); } }
            }
        }, true);
        public void Background()
        {
            // OS authentication sheet must retain its in-memory PKCE context.
            if (browserPending) return;
            suspended = true; ResetMemory(); busy = false;
            Set(SessionState.BOOTSTRAPPING);
        }
        public Task Foreground()
        { if (!suspended) return Task.CompletedTask; suspended = false; return Start(); }
        private async Task Run(Func<Task> action, bool allowBusy = false)
        {
            if (disposed || (busy && !allowBusy)) return;
            busy = true; Changed?.Invoke();
            int epoch = generation;
            try { await action(); }
            catch (OperationCanceledException)
            { if (!suspended && !disposed && epoch == generation) Set(SessionState.UNAUTHENTICATED, Failure.Cancelled); }
            catch (MobileFailure failure)
            {
                if (epoch != generation || suspended || disposed) return;
                Snapshot = null; Chronicle = null;
                if (failure.Kind == Failure.Unauthorized)
                { access = null; await store.DeleteAsync(CancellationToken.None); Set(SessionState.SESSION_EXPIRED, failure.Kind); }
                else Set(failure.Kind == Failure.Configuration ? SessionState.FATAL_CONFIGURATION_ERROR : failure.Kind == Failure.StepUp ? SessionState.AUTHENTICATED : SessionState.DEGRADED, failure.Kind);
            }
            catch { if (epoch == generation && !suspended && !disposed) { Snapshot = null; Chronicle = null; access = null; Set(SessionState.DEGRADED, Failure.Unavailable); } }
            finally { if (epoch == generation) busy = false; Changed?.Invoke(); }
        }
        public void Dispose()
        { disposed = true; ResetMemory();
            browser.Cancel(); lifetime.Dispose(); Changed = null; }
    }
}
