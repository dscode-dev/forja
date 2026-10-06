using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Forja.Application;
using Forja.Core;
using Forja.Infrastructure;
using NUnit.Framework;

namespace Forja.Tests
{
    public class MobileTests
    {
        private static MobileSettings Settings() => new MobileSettings("development", "https://api.example.test", "https://identity.example.test", "native", "com.darlan.forja.dev:/auth/callback");
        [Test] public void PkceStandardVector()
        { Assert.That(Pkce.Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), Is.EqualTo("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")); Assert.That(Pkce.Verifier().Length, Is.EqualTo(43)); }
        [TestCase("http://api.example.test")]
        [TestCase("https://user:secret@api.example.test")]
        [TestCase("https://api.example.test?token=secret")]
        [TestCase("https://api.example.test/path")]
        public void BadConfiguration(string url)
        { Assert.Throws<Exception>(() => { try { _ = new MobileSettings("production", url, "", "", "com.darlan.forja.dev:/auth/callback"); } catch(Exception) { throw new Exception(); } }); }
        [Test] public void ProductionRequiresProvider()
        { Assert.Throws<MobileFailure>(() => new MobileSettings("production", "https://api.example.test", "", "", "com.darlan.forja.dev:/auth/callback")); }
        [Test] public void CallbackBindsStateAndPath()
        {
            Assert.That(Pkce.Code("com.darlan.forja.dev:/auth/callback?code=abc&state=s", Settings().Redirect, "s"), Is.EqualTo("abc"));
            Assert.Throws<MobileFailure>(() => Pkce.Code("com.darlan.forja.dev:/auth/callback?code=a&state=s&state=s", Settings().Redirect, "s"));
            Assert.Throws<MobileFailure>(() => Pkce.Code("com.darlan.forja.dev:/other?code=a&state=s", Settings().Redirect, "s"));
            Assert.Throws<MobileFailure>(() => Pkce.Code("com.darlan.forja.dev:/auth/callback?code=a&state=wrong", Settings().Redirect, "s"));
        }
        [Test] public void MoneyOnlyFormatsExactStrings()
        {
            Assert.That(MoneyDisplay.Format("999999999999999999", "BRL", 2), Is.EqualTo("BRL 9999999999999999,99"));
            Assert.That(MoneyDisplay.Format("-1", "KWD", 3), Is.EqualTo("KWD −0,001"));
            Assert.Throws<MobileFailure>(() => MoneyDisplay.Format("1.2", "BRL", 2));
            Assert.Throws<MobileFailure>(() => MoneyDisplay.Format("1", "ZZZ", 2));
        }
        [Test] public void JsonRejectsDuplicateAndTrailingMalformedValues()
        { Assert.Throws<MobileFailure>(() => BackendApi.Parse("{\"a\":1,\"a\":2}")); Assert.Throws<MobileFailure>(() => BackendApi.Parse("{} {}")); Assert.Throws<MobileFailure>(() => BackendApi.Parse("{")); }
        [TestCase(401, Failure.Unauthorized)] [TestCase(403, Failure.StepUp)] [TestCase(503, Failure.Unavailable)] [TestCase(400, Failure.Protocol)]
        public void ErrorMapping(int status, Failure failure) { Assert.That(BackendApi.Map(status), Is.EqualTo(failure)); }
        [Test] public async Task NoCredentialsRemainUnauthenticated()
        { var store = new Store(); using(var session = new SessionCoordinator(new Api(),store,new Browser(),Settings())) { await session.Start(); Assert.That(session.State,Is.EqualTo(SessionState.UNAUTHENTICATED)); Assert.That(session.Snapshot,Is.Null); } }
        [Test] public async Task ResumeRotatesThenRefetches()
        {
            var api = new Api(); var store = new Store { Value = new string('r',43) };
            using(var session = new SessionCoordinator(api,store,new Browser(),Settings()))
            {
                await session.Start(); Assert.That(session.State,Is.EqualTo(SessionState.AUTHENTICATED));
                Assert.That(store.Value,Is.EqualTo(new string('n',43)));
                session.Background(); Assert.That(session.Snapshot,Is.Null);
                await session.Foreground(); Assert.That(api.RefreshCount,Is.EqualTo(2)); Assert.That(api.ReadCount,Is.EqualTo(2));
            }
        }
        [Test] public async Task ExpiryRenewsBeforeRead()
        {
            var time = DateTimeOffset.UtcNow; var api=new Api();var store=new Store{Value=new string('r',43)};
            using(var session=new SessionCoordinator(api,store,new Browser(),Settings(),()=>time))
            { await session.Start();time=time.AddMinutes(5);await session.Reload();Assert.That(api.RefreshCount,Is.EqualTo(2)); }
        }
        [Test] public async Task LostRefreshDeletesCredentialWithoutRetry()
        {
            var api = new Api { RefreshFailure = Failure.Timeout }; var store = new Store { Value = new string('r',43) };
            using(var session=new SessionCoordinator(api,store,new Browser(),Settings()))
            { await session.Start(); Assert.That(store.Value,Is.Null);Assert.That(session.Snapshot,Is.Null);await session.Start();Assert.That(api.RefreshCount,Is.EqualTo(1));Assert.That(session.State,Is.EqualTo(SessionState.UNAUTHENTICATED)); }
        }
        [Test] public async Task OfflineLogoutIsImmediateAndNoRevocationClaim()
        {
            var api=new Api{RevokeFailure=true}; var store=new Store{Value=new string('r',43)};
            using(var session=new SessionCoordinator(api,store,new Browser(),Settings()))
            {await session.Start();await session.Logout();Assert.That(store.Value,Is.Null);Assert.That(session.Snapshot,Is.Null);Assert.That(session.State,Is.EqualTo(SessionState.UNAUTHENTICATED));Assert.That(session.Error,Is.EqualTo(Failure.Unavailable));}
        }
        [Test] public async Task CancelledHttpUsesCallerCancellation()
        {
            using(var api=new BackendApi(Settings().Endpoint,new Handler(async token=>{await Task.Delay(5000,token);return null;})))
            using(var cancellation=new CancellationTokenSource())
            {cancellation.Cancel();Assert.ThrowsAsync<TaskCanceledException>(async()=>await api.Ready(cancellation.Token));await Task.CompletedTask;}
        }
        [Test] public void MissingNoStoreRejectsResponse()
        {
            using(var api=new BackendApi(Settings().Endpoint,new Handler(token=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("{\"status\":\"ok\"}")}))))
            {var failure=Assert.ThrowsAsync<MobileFailure>(async()=>await api.Ready(CancellationToken.None));Assert.That(failure.Kind,Is.EqualTo(Failure.Protocol));}
        }
        [Test] public async Task HttpTimeoutIsSafeFailure()
        {
            using(var api=new BackendApi(Settings().Endpoint,new Handler(async token=>{await Task.Delay(5000,token);return null;}),30))
            {MobileFailure failure=null;try {await api.Ready(CancellationToken.None);} catch(MobileFailure error){failure=error;} Assert.That(failure,Is.Not.Null);Assert.That(failure.Kind,Is.EqualTo(Failure.Timeout));}
        }
        [Test] public async Task LoginUsesBoundPkceAndPersistsOnlyRefresh()
        {
            var api=new Api();var store=new Store();var browser=new Browser{Callback="com.darlan.forja.dev:/auth/callback?code=ok&state="+new string('s',43)};
            using(var session=new SessionCoordinator(api,store,browser,Settings()))
            {await session.Login("login");Assert.That(session.State,Is.EqualTo(SessionState.AUTHENTICATED));Assert.That(api.Challenge,Is.EqualTo(Pkce.Challenge(api.Verifier)));Assert.That(store.Value,Is.EqualTo(new string('n',43)));}
        }
        [Test] public async Task WrongCallbackCannotCompleteAuthentication()
        {
            var api=new Api();var browser=new Browser{Callback="com.darlan.forja.dev:/auth/callback?code=ok&state=wrong"};
            using(var session=new SessionCoordinator(api,new Store(),browser,Settings()))
            {await session.Login("login");Assert.That(api.Verifier,Is.Null);Assert.That(session.Snapshot,Is.Null);Assert.That(session.Error,Is.EqualTo(Failure.Protocol));}
        }
        [Test] public async Task LateResponseAfterLogoutCannotRepopulatePrivateState()
        {
            var api=new Api();var store=new Store{Value=new string('r',43)};
            using(var session=new SessionCoordinator(api,store,new Browser(),Settings()))
            {
                await session.Start();api.DelayedRead=new TaskCompletionSource<ShellSnapshot>();
                var load=session.Reload();await session.Logout();
                api.DelayedRead.SetResult(new ShellSnapshot{Name="private test fixture"});await load;
                Assert.That(session.State,Is.EqualTo(SessionState.UNAUTHENTICATED));Assert.That(session.Snapshot,Is.Null);Assert.That(store.Value,Is.Null);
            }
        }
        [Test] public async Task LateResponseAfterBackgroundCannotRestoreView()
        {
            var api=new Api();var store=new Store{Value=new string('r',43)};
            using(var session=new SessionCoordinator(api,store,new Browser(),Settings()))
            {await session.Start();api.DelayedRead=new TaskCompletionSource<ShellSnapshot>();var load=session.Reload();session.Background();api.DelayedRead.SetResult(new ShellSnapshot());await load;Assert.That(session.Snapshot,Is.Null);Assert.That(session.State,Is.EqualTo(SessionState.BOOTSTRAPPING));}
        }
        [Test] public async Task ReplayedSessionBecomesExpired()
        {
            var api=new Api{RefreshFailure=Failure.Unauthorized};var store=new Store{Value=new string('r',43)};
            using(var session=new SessionCoordinator(api,store,new Browser(),Settings()))
            {await session.Start();Assert.That(session.State,Is.EqualTo(SessionState.SESSION_EXPIRED));Assert.That(store.Value,Is.Null);}
        }
        [Test] public async Task InterruptedRotationNeverReplaysStoredCredential()
        {
            var api=new Api{DelayedRefresh=new TaskCompletionSource<Tokens>()};var store=new Store{Value=new string('r',43)};
            using(var session=new SessionCoordinator(api,store,new Browser(),Settings()))
            {
                var first=session.Start();session.Background();Assert.That(store.Value,Is.Null);
                api.DelayedRefresh.SetResult(new Tokens{Access=new string('a',43),Refresh=new string('n',43),ExpiresIn=300});await first;
                await session.Foreground();Assert.That(session.State,Is.EqualTo(SessionState.UNAUTHENTICATED));Assert.That(api.RefreshCount,Is.EqualTo(1));Assert.That(session.Snapshot,Is.Null);
            }
        }
        [Test] public async Task ConcurrentBootstrapCannotDuplicateRefresh()
        {
            var api=new Api{DelayedRefresh=new TaskCompletionSource<Tokens>()};var store=new Store{Value=new string('r',43)};
            using(var session=new SessionCoordinator(api,store,new Browser(),Settings()))
            {var first=session.Start();await session.Start();Assert.That(api.RefreshCount,Is.EqualTo(1));api.DelayedRefresh.SetResult(new Tokens{Access=new string('a',43),Refresh=new string('n',43),ExpiresIn=300});await first;Assert.That(session.State,Is.EqualTo(SessionState.AUTHENTICATED));}
        }
        [Test] public async Task RefreshErasesOldCredentialBeforeTransmission()
        {
            var store=new Store{Value=new string('r',43)};var api=new Api{DuringRefresh=()=>Assert.That(store.Value,Is.Null)};
            using(var session=new SessionCoordinator(api,store,new Browser(),Settings()))
            {await session.Start();Assert.That(session.State,Is.EqualTo(SessionState.AUTHENTICATED));Assert.That(store.Value,Is.EqualTo(new string('n',43)));}
        }
        [Test] public async Task StorageDeleteFailureCannotTransmitRefresh()
        {
            var store=new Store{Value=new string('r',43),FailDelete=true};var api=new Api();
            using(var session=new SessionCoordinator(api,store,new Browser(),Settings()))
            {await session.Start();Assert.That(api.RefreshCount,Is.EqualTo(0));Assert.That(session.State,Is.EqualTo(SessionState.FATAL_CONFIGURATION_ERROR));Assert.That(session.Snapshot,Is.Null);}
        }
        // Doubles are restricted to this automated test assembly.
        private sealed class Store : ISessionCredentialStore
        {
            public string Value;public bool FailDelete;
            public Task<string> ReadAsync(CancellationToken c)=>Task.FromResult(Value);
            public Task WriteAsync(string v,CancellationToken c){Value=v;return Task.CompletedTask;}
            public Task DeleteAsync(CancellationToken c){if(FailDelete)throw new MobileFailure(Failure.Configuration);Value=null;return Task.CompletedTask;}
        }
        private sealed class Browser : IAuthorizationBrowser
        {public string Callback;public Task<string> Authorize(string a,string s,CancellationToken c)=>Task.FromResult(Callback);public void Cancel(){}}
        private sealed class Api : IBackendApi
        {
            public Action DuringRefresh;public int RefreshCount,ReadCount;public Failure? RefreshFailure;public bool RevokeFailure;public string Challenge,Verifier;public TaskCompletionSource<ShellSnapshot> DelayedRead;public TaskCompletionSource<Tokens> DelayedRefresh;
            public Task Ready(CancellationToken c)=>Task.CompletedTask;
            public Task<AuthChallenge> Begin(string a,string i,CancellationToken c){Challenge=a;return Task.FromResult(new AuthChallenge{Id=Guid.NewGuid().ToString(),State=new string('s',43),Nonce=new string('q',43),AuthorizationUrl="https://identity.example.test/auth?client_id=native&redirect_uri="+Uri.EscapeDataString(Settings().Redirect)+"&state="+new string('s',43)+"&nonce="+new string('q',43)+"&code_challenge="+a+"&code_challenge_method=S256&response_type=code",ExpiresIn=300});}
            public Task<Tokens> Complete(AuthChallenge a,string v,string code,CancellationToken c){Verifier=v;return Task.FromResult(new Tokens{Access=new string('a',43),Refresh=new string('n',43),ExpiresIn=300});}
            public Task<Tokens> Refresh(string r,CancellationToken c){RefreshCount++;DuringRefresh?.Invoke();if(RefreshFailure.HasValue)throw new MobileFailure(RefreshFailure.Value);return DelayedRefresh==null?Task.FromResult(new Tokens{Access=new string('a',43),Refresh=new string('n',43),ExpiresIn=300}):DelayedRefresh.Task;}
            public Task Revoke(string a,bool all,CancellationToken c){if(RevokeFailure)throw new MobileFailure(Failure.Offline);return Task.CompletedTask;}
            public Task<ShellSnapshot> Read(string a,CancellationToken c){ReadCount++;return DelayedRead==null?Task.FromResult(new ShellSnapshot()):DelayedRead.Task;}
        }
        private sealed class Handler : HttpMessageHandler
        {
            private readonly Func<CancellationToken,Task<HttpResponseMessage>> action;
            public Handler(Func<CancellationToken,Task<HttpResponseMessage>> action){this.action=action;}
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken c)=>action(c);
        }
    }
}
