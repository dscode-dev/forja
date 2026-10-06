using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Authentication;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Forja.Application;
using Forja.Core;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Forja.Infrastructure
{
    public sealed class BackendApi : IBackendApi, IDisposable
    {
        private readonly HttpClient client;
        private readonly Uri origin;
        private readonly int timeoutMilliseconds;
        public BackendApi(ApiEndpoint endpoint, HttpMessageHandler handler = null, int timeoutMilliseconds = 15000)
        {
            if (timeoutMilliseconds < 1 || timeoutMilliseconds > 60000) throw new ArgumentOutOfRangeException(nameof(timeoutMilliseconds));
            this.timeoutMilliseconds = timeoutMilliseconds;
            origin = endpoint.BaseUri;
            // No redirects, cookies, disk cache or certificate-validation overrides.
            client = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false, SslProtocols = SslProtocols.Tls12 });
            client.Timeout = Timeout.InfiniteTimeSpan;
        }
        public static Failure Map(int status) => status == 401 ? Failure.Unauthorized : status == 403 ? Failure.StepUp : status == 429 || status >= 500 ? Failure.Unavailable : Failure.Protocol;
        public static JObject Parse(string body)
        {
            try
            {
                using (var reader = new JsonTextReader(new StringReader(body)) { DateParseHandling = DateParseHandling.None, MaxDepth = 32 })
                {
                    var value = JObject.Load(reader, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error });
                    if (reader.Read()) throw new MobileFailure(Failure.Protocol);
                    return value;
                }
            }
            catch (JsonException) { throw new MobileFailure(Failure.Protocol); }
        }
        private async Task<JObject> Send(string path, string access, JObject body, CancellationToken cancellation, bool missing = false, bool bounded = false)
        {
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            using (var request = new HttpRequestMessage(body == null ? HttpMethod.Get : HttpMethod.Post, new Uri(origin, path)))
            {
                timeout.CancelAfter(timeoutMilliseconds);
                request.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true };
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                if (access != null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
                if (body != null) request.Content = new StringContent(body.ToString(Formatting.None), Encoding.UTF8, "application/json");
                try
                {
                    using (var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token))
                    {
                        int status = (int)response.StatusCode;
                        if (response.Headers.CacheControl?.NoStore != true) throw new MobileFailure(Failure.Protocol);
                        if (status == 404 && missing) return null;
                        if (status == 422 && bounded) throw new MobileFailure(Failure.Unavailable);
                        if (!response.IsSuccessStatusCode) throw new MobileFailure(Map(status));
                        if (status == 204) return new JObject();
                        if (status != 200 || response.Content.Headers.ContentType?.MediaType != "application/json") throw new MobileFailure(Failure.Protocol);
                        if (response.Content.Headers.ContentLength > 524288) throw new MobileFailure(Failure.Protocol);
                        using (var input = await response.Content.ReadAsStreamAsync())
                        using (var bytes = new MemoryStream())
                        {
                            var buffer = new byte[8192]; int size;
                            while ((size = await input.ReadAsync(buffer, 0, buffer.Length, timeout.Token)) > 0)
                            { if (bytes.Length + size > 524288) throw new MobileFailure(Failure.Protocol); bytes.Write(buffer, 0, size); }
                            return Parse(new UTF8Encoding(false, true).GetString(bytes.ToArray()));
                        }
                    }
                }
                catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { throw new MobileFailure(Failure.Timeout); }
                catch (HttpRequestException) { throw new MobileFailure(Failure.Offline); }
                catch (IOException) { throw new MobileFailure(Failure.Offline); }
                catch (DecoderFallbackException) { throw new MobileFailure(Failure.Protocol); }
            }
        }
        private static string Text(JToken value, string key)
        {
            var token = value?[key];
            if (token == null || token.Type != JTokenType.String || ((string)token).Length > 2048) throw new MobileFailure(Failure.Protocol);
            return (string)token;
        }
        private static int Integer(JToken value, string key)
        { var token = value?[key]; if (token?.Type != JTokenType.Integer || (long)token < 0 || (long)token > int.MaxValue) throw new MobileFailure(Failure.Protocol); return (int)token; }
        private static JArray Array(JToken value, string key)
        { if (!(value?[key] is JArray array) || array.Count > 100) throw new MobileFailure(Failure.Protocol); return array; }
        private static string Id(JToken value, string key)
        { string text = Text(value, key); if (!Guid.TryParseExact(text, "D", out _)) throw new MobileFailure(Failure.Protocol); return text; }
        private static string Amount(JToken value, string key, string currency) => MoneyDisplay.Format(Text(value, key), currency, MoneyDisplay.Digits(currency));
        private static Tokens TokenResponse(JObject value)
        {
            if (Text(value, "tokenType") != "Bearer") throw new MobileFailure(Failure.Protocol);
            var tokens = new Tokens { Access = Text(value, "accessToken"), Refresh = Text(value, "refreshToken"), ExpiresIn = Integer(value, "expiresIn") };
            tokens.Validate(); return tokens;
        }
        public async Task Ready(CancellationToken cancellation)
        { var result = await Send("health/ready", null, null, cancellation); if (Text(result, "status") != "ok") throw new MobileFailure(Failure.Unavailable); }
        public async Task<AuthChallenge> Begin(string challenge, string intent, CancellationToken cancellation)
        {
            var result = await Send("v1/auth/begin", null, new JObject { ["codeChallenge"] = challenge, ["intent"] = intent }, cancellation);
            var value = new AuthChallenge { Id = Id(result, "challengeId"), State = Text(result, "state"), Nonce = Text(result, "nonce"), AuthorizationUrl = Text(result, "authorizationUrl"), ExpiresIn = Integer(result, "expiresIn") };
            if (!Regex.IsMatch(value.State, "^[A-Za-z0-9_-]{43}$") || !Regex.IsMatch(value.Nonce, "^[A-Za-z0-9_-]{43}$") || value.ExpiresIn < 1 || value.ExpiresIn > 300) throw new MobileFailure(Failure.Protocol);
            return value;
        }
        public async Task<Tokens> Complete(AuthChallenge challenge, string verifier, string code, CancellationToken cancellation) => TokenResponse(await Send("v1/auth/complete", null,
            new JObject { ["challengeId"] = challenge.Id, ["state"] = challenge.State, ["nonce"] = challenge.Nonce, ["code"] = code, ["codeVerifier"] = verifier }, cancellation));
        public async Task<Tokens> Refresh(string refresh, CancellationToken cancellation) => TokenResponse(await Send("v1/auth/refresh", null, new JObject { ["refreshToken"] = refresh }, cancellation));
        public async Task Revoke(string access, bool all, CancellationToken cancellation) => await Send(all ? "v1/auth/revoke-all" : "v1/auth/logout", access, new JObject(), cancellation);
        public async Task<ShellSnapshot> Read(string access, CancellationToken cancellation)
        {
            var me = await Send("v1/me", access, null, cancellation);
            Id(me, "userId"); Integer(me, "revision");
            var snapshot = new ShellSnapshot { Name = me["displayName"]?.Type == JTokenType.Null ? null : Text(me, "displayName") };
            var accounts = await Send("v1/finance/accounts?limit=100", access, null, cancellation);
            if (Integer(accounts, "rule") != 1) throw new MobileFailure(Failure.Protocol);
            foreach (var account in Array(accounts, "accounts"))
            {
                Id(account, "id"); string currency = Text(account, "currency");
                string state = Text(account, "state");
                if (state != "active" && state != "closed") throw new MobileFailure(Failure.Protocol);
                snapshot.Accounts.Add(new AccountView { Id = Id(account, "id"), Name = Text(account, "name"), Balance = MoneyDisplay.Format(Text(account, "balanceMinor"), currency, Integer(account, "minorDigits")), State = state, Currency = currency });
            }
            snapshot.AccountNext = accounts["next"]?.Type == JTokenType.Null ? null : Id(accounts, "next");
            // One bounded server-computed forecast for the explicitly named first account.
            // No client aggregation, expected amount arithmetic or all-account forecast.
            if (snapshot.Accounts.Count > 0)
            {
                var account = snapshot.Accounts[0];
                string through = DateTime.UtcNow.Date.AddDays(7).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
                try
                {
                    var summary = await Send("v1/planning/expected/summary?accountId=" + account.Id + "&through=" + Uri.EscapeDataString(through), access, null, cancellation, bounded: true);
                    if (Integer(summary, "rule") != 1 || Id(summary, "accountId") != account.Id || Text(summary, "currency") != account.Currency || Text(summary, "through") != through) throw new MobileFailure(Failure.Protocol);
                    snapshot.Forecast = new ForecastView { AccountId = account.Id, AccountName = account.Name,
                        AsOf = Text(summary, "asOf"), Through = Text(summary, "through"),
                        Projected = Amount(summary, "projectedBalanceMinor", account.Currency), Receivable = Amount(summary, "receivableMinor", account.Currency),
                        Payable = Amount(summary, "payableMinor", account.Currency), PredictedIncome = Amount(summary, "predictedIncomeMinor", account.Currency),
                        ScheduledDebit = Amount(summary, "scheduledDebitMinor", account.Currency) };
                }
                catch (MobileFailure failure) when (failure.Kind == Failure.Unavailable || failure.Kind == Failure.Offline || failure.Kind == Failure.Timeout) { /* optional forecast unavailable; never invent zeros */ }
            }
            var work = await Send("v1/work/profile", access, null, cancellation, missing: true);
            if (work != null)
            {
                var profile = work["profile"];
                snapshot.Work = new WorkView { Occupation = profile?["occupation"]?.Type == JTokenType.Null ? "Perfil profissional cadastrado" : Text(profile, "occupation") };
                var today = DateTime.UtcNow.Date;
                string from = today.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
                string through = today.AddDays(6).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
                var capacity = await Send("v1/work/capacity?from=" + from + "&through=" + through + "&revision=" + Integer(work, "revision"), access, null, cancellation);
                if (Integer(capacity, "profileRevision") != Integer(work, "revision") || Integer(capacity, "formulaVersion") != 1 || Text(capacity, "timezone") != "UTC") throw new MobileFailure(Failure.Protocol);
                snapshot.Work.From = from; snapshot.Work.Through = through;
                snapshot.Work.Estimate = capacity["totalMinor"]?.Type == JTokenType.Null ? null : Amount(capacity, "totalMinor", Text(capacity, "currency"));
            }
            var goals = await Send("v1/planning/goals?limit=100", access, null, cancellation);
            foreach (var goal in Array(goals, "goals"))
            {
                string id = Id(goal, "id"); var config = goal["goal"]; string currency = Text(config, "currency");
                var progress = await Send("v1/planning/goals/" + id + "/progress", access, null, cancellation);
                if (Id(progress, "goalId") != id || Integer(progress, "goalRevision") != Integer(goal, "revision") || Text(progress, "currency") != currency) throw new MobileFailure(Failure.Protocol);
                string state = Text(goal, "status");
                string stateLabel = state == "ACTIVE" ? "Ativa" : state == "PAUSED" ? "Pausada" : state == "COMPLETED" ? "Concluída" : state == "CANCELLED" ? "Cancelada" : null;
                if (stateLabel == null) throw new MobileFailure(Failure.Protocol);
                snapshot.Goals.Add(new GoalView { Id = id, Title = Text(config, "title"), State = stateLabel, Target = Amount(config, "targetMinor", currency), Credited = Amount(progress, "creditedMinor", currency), Remaining = Amount(progress, "remainingMinor", currency) });
            }
            snapshot.GoalNext = goals["next"]?.Type == JTokenType.Null ? null : Id(goals, "next");
            return snapshot;
        }
        public void Dispose() => client.Dispose();
    }
}
