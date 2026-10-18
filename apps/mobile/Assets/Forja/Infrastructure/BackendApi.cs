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
        private async Task<JObject> Send(string path, string access, JObject body, CancellationToken cancellation, bool missing = false, bool bounded = false, bool report = false, bool put = false)
        {
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            using (var request = new HttpRequestMessage(put ? HttpMethod.Put : body == null ? HttpMethod.Get : HttpMethod.Post, new Uri(origin, path)))
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
                        if (report && status == 400) throw new MobileFailure(Failure.InvalidPeriod);
                        if (report && status == 404) throw new MobileFailure(Failure.ChronicleExpired);
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
        private static AiPreferences Preference(JObject value)
        {
            if (value["enabled"]?.Type != JTokenType.Boolean || value["providerAvailable"]?.Type != JTokenType.Boolean) throw new MobileFailure(Failure.Protocol);
            return new AiPreferences { Enabled = (bool)value["enabled"], ProviderAvailable = (bool)value["providerAvailable"], Revision = Integer(value, "revision"), PolicyVersion = Text(value, "policyVersion"), Disclosure = Text(value, "disclosure") };
        }
        public async Task<AiPreferences> ReadAiPreferences(string access, CancellationToken cancellation) => Preference(await Send("v1/ai/preferences", access, null, cancellation));
        public async Task<AiPreferences> SetAiPreferences(string access, AiPreferences previous, bool enabled, CancellationToken cancellation) => Preference(await Send("v1/ai/preferences", access,
            new JObject { ["revision"] = previous.Revision, ["enabled"] = enabled, ["policyVersion"] = previous.PolicyVersion }, cancellation, put: true));
        private static string Inert(JToken value, string key)
        {
            string text = Text(value, key);
            if (text.Length > 600 || Regex.IsMatch(text, @"[<>\d]|https?://")) throw new MobileFailure(Failure.Protocol);
            return text;
        }
        private static AiAnalysis Analysis(JObject value, string reportId)
        {
            var state = Text(value, "state");
            if (System.Array.IndexOf(new[] { "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "DISABLED", "UNAVAILABLE", "ABSENT", "EXPIRED", "INSUFFICIENT_CONTEXT", "THROTTLED" }, state) < 0 || Id(value, "reportId") != reportId || value["cached"]?.Type != JTokenType.Boolean) throw new MobileFailure(Failure.Protocol);
            var result = new AiAnalysis { State = state, ReportId = reportId, Cached = (bool)value["cached"], ExecutionId = value["executionId"]?.Type == JTokenType.Null ? null : Id(value, "executionId") };
            var narrative = value["narrative"];
            if (state != "SUCCEEDED") { if (narrative?.Type != JTokenType.Null) throw new MobileFailure(Failure.Protocol); return result; }
            if (Integer(narrative, "schema") != 1 || Text(narrative, "kind") != "AI_INTERPRETATION" || Text(narrative, "method") != "MODEL_SELECTED_REVIEWED_TEXT") throw new MobileFailure(Failure.Protocol);
            result.Summary = Inert(narrative["summary"], "text");
            void Lines(string key, System.Collections.Generic.List<string> lines, bool plain = false)
            {
                var items = Array(narrative, key); if (items.Count > 6) throw new MobileFailure(Failure.Protocol);
                foreach (var item in items) lines.Add(Inert(plain ? new JObject { ["text"] = item } : item, "text"));
            }
            Lines("highlights", result.Highlights); Lines("attentionPoints", result.Attention); Lines("observations", result.Observations); Lines("questions", result.Questions, true); Lines("limitations", result.Limitations, true);
            return result;
        }
        public async Task<AiAnalysis> ReadAlquimista(string access, string reportId, CancellationToken cancellation) => Analysis(await Send("v1/ai/alquimista/" + reportId, access, null, cancellation, report: true), reportId);
        public async Task<AiAnalysis> RequestAlquimista(string access, string reportId, string key, string retryOf, CancellationToken cancellation) => Analysis(await Send("v1/ai/alquimista/" + reportId, access,
            new JObject { ["requestKey"] = key, ["retryOf"] = retryOf == null ? JValue.CreateNull() : new JValue(retryOf) }, cancellation, report: true), reportId);
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
                snapshot.Goals.Add(new GoalView { Id = id, Title = Text(config, "title"), Revision = Integer(goal, "revision"), State = stateLabel, Target = Amount(config, "targetMinor", currency), Credited = Amount(progress, "creditedMinor", currency), Remaining = Amount(progress, "remainingMinor", currency) });
            }
            snapshot.GoalNext = goals["next"]?.Type == JTokenType.Null ? null : Id(goals, "next");
            snapshot.Game = await ReadGame(access, snapshot.Goals.Count == 0 ? null : snapshot.Goals[0].Id, cancellation);
            var periods = await Send("v1/reports/periods", access, null, cancellation);
            if (Integer(periods, "reportVersion") != 1) throw new MobileFailure(Failure.Protocol);
            snapshot.ReportToday = Text(periods, "today"); snapshot.ReportTimezone = Text(periods, "timezone");
            snapshot.Chronicles = await ReadChronicles(access, 0, cancellation);
            return snapshot;
        }
        private static long LongInteger(JToken value, string key)
        { var token = value?[key]; if (token?.Type != JTokenType.Integer || (long)token < 0 || (long)token > 9007199254740891L) throw new MobileFailure(Failure.Protocol); return (long)token; }
        private static MissionView Mission(JToken item)
        {
            string state = Text(item, "state");
            if (Integer(item, "definitionVersion") != 1 || (state != "ACTIVE" && state != "COMPLETED" && state != "EXPIRED" && state != "CANCELLED")) throw new MobileFailure(Failure.Protocol);
            string rewardState = Text(item, "rewardState");
            if (rewardState != (state == "COMPLETED" ? "AWARDED" : "NOT_AWARDED")) throw new MobileFailure(Failure.Protocol);
            var progress = item["progress"]; string kind = Text(progress, "kind");
            string current, target;
            if (kind == "confirmed-profile") { current = Integer(progress, "current") == 1 ? "Perfil confirmado" : "Perfil ainda não confirmado"; target = "Confirmar perfil profissional"; }
            else if (kind == "settled-goal")
            {
                string currency = Text(progress, "currency");
                current = progress["currentMinor"]?.Type == JTokenType.Null ? null : Amount(progress, "currentMinor", currency);
                target = Amount(progress, "targetMinor", currency);
            }
            else throw new MobileFailure(Failure.Protocol);
            string reconciliation = Text(item, "reconciliation"); if (reconciliation != "UNCHANGED" && reconciliation != "CHANGED") throw new MobileFailure(Failure.Protocol);
            return new MissionView { Id = Id(item, "id"), Title = Text(item, "title"), Description = Text(item, "description"), State = state, RewardXp = Integer(item, "rewardXp"), ExpiresAt = Text(item, "expiresAt"), RecordedAt = Text(item, "recordedAt"), Reconciliation = reconciliation, Current = current, Target = target, Financial = kind == "settled-goal" };
        }
        private async Task<GameView> ReadGame(string access, string goalId, CancellationToken cancellation)
        {
            var summary = await Send("v1/game/progression", access, null, cancellation);
            if (Integer(summary, "curveVersion") != 1) throw new MobileFailure(Failure.Protocol);
            var game = new GameView { Xp = LongInteger(summary, "xp"), Level = LongInteger(summary, "level"), NextLevelXp = LongInteger(summary, "nextLevelXp"), XpToNextLevel = LongInteger(summary, "xpToNextLevel") };
            foreach (string view in new[] { "active", "history" })
            {
                var page = await Send("v1/game/missions?limit=20&view=" + view, access, null, cancellation);
                var destination = view == "active" ? game.Active : game.History;
                foreach (var item in Array(page, "missions")) destination.Add(Mission(item));
                string next = page["next"]?.Type == JTokenType.Null ? null : Id(page, "next");
                if (view == "active") game.ActiveNext = next; else game.HistoryNext = next;
            }
            var candidates = await Send("v1/game/candidates" + (goalId == null ? "" : "?goalId=" + goalId), access, null, cancellation);
            foreach (var candidate in Array(candidates, "candidates"))
            {
                string template = Text(candidate, "template");
                if (template != "WORK_PROFILE" && template != "GOAL_TARGET" && template != "RESERVE_TARGET") throw new MobileFailure(Failure.Protocol);
                string target = candidate["goalId"]?.Type == JTokenType.Null ? null : Id(candidate, "goalId");
                int? revision = candidate["goalRevision"]?.Type == JTokenType.Null ? (int?)null : Integer(candidate, "goalRevision");
                if (template == "WORK_PROFILE" ? target != null || revision != null : target == null || revision == null || revision <= 0 || target != goalId) throw new MobileFailure(Failure.Protocol);
                game.Candidates.Add(new MissionCandidate { Template = template, GoalId = target, GoalRevision = revision });
            }
            return game;
        }
        public async Task AssignMission(string access, MissionCandidate candidate, string key, CancellationToken cancellation)
        {
            await Send("v1/game/missions", access, new JObject { ["idempotencyKey"] = key, ["template"] = candidate.Template, ["goalId"] = candidate.GoalId == null ? JValue.CreateNull() : new JValue(candidate.GoalId), ["goalRevision"] = candidate.GoalRevision.HasValue ? new JValue(candidate.GoalRevision.Value) : JValue.CreateNull() }, cancellation);
        }
        public async Task EvaluateMission(string access, string id, bool cancel, CancellationToken cancellation)
        {
            if (!Guid.TryParseExact(id, "D", out _)) throw new MobileFailure(Failure.Protocol);
            await Send("v1/game/missions/" + id + (cancel ? "/cancel" : "/evaluate"), access, new JObject(), cancellation);
        }
        private static ChronicleItem ChronicleItem(JToken item, bool detail)
        {
            var period = item["period"]; string type = Text(period, "type");
            if (type != "DAILY" && type != "WEEKLY" && type != "MONTHLY" && type != "CUSTOM") throw new MobileFailure(Failure.Protocol);
            return new ChronicleItem { Id = Id(item, "id"), AccountId = detail ? Id(item["request"], "accountId") : Id(item, "accountId"),
                Currency = detail ? Text(item["finance"], "currency") : Text(item, "currency"), Generation = Integer(item, "generation"), Type = type,
                From = Text(period["current"], "from"), Through = Text(period["current"], "through"), GeneratedAt = Text(item, "generatedAt"), ExpiresAt = Text(item, "expiresAt") };
        }
        public async Task<ChroniclePage> ReadChronicles(string access, int after, CancellationToken cancellation)
        {
            if (after < 0) throw new MobileFailure(Failure.Protocol);
            var value = await Send("v1/reports/chronicles?limit=20&after=" + after.ToString(System.Globalization.CultureInfo.InvariantCulture), access, null, cancellation);
            var page = new ChroniclePage();
            foreach (var item in Array(value, "chronicles")) page.Items.Add(ChronicleItem(item, false));
            page.Next = value["next"]?.Type == JTokenType.Null ? (int?)null : Integer(value, "next");
            if (page.Next.HasValue && page.Next.Value <= after) throw new MobileFailure(Failure.Protocol);
            return page;
        }
        private static ChronicleView Chronicle(JObject value)
        {
            if (Integer(value, "reportVersion") != 1) throw new MobileFailure(Failure.Protocol);
            var result = new ChronicleView { Item = ChronicleItem(value, true), Timezone = Text(value["period"], "timezone") };
            if (value["period"]?["partial"]?.Type != JTokenType.Boolean) throw new MobileFailure(Failure.Protocol);
            result.Partial = (bool)value["period"]["partial"];
            string currency = result.Item.Currency, locale = Text(value, "locale");
            void Money(System.Collections.Generic.List<ChronicleLine> lines, string label, JToken source, string key)
            { lines.Add(new ChronicleLine { Label = label, Value = source?[key]?.Type == JTokenType.Null ? "Não disponível" : MoneyDisplay.FormatLocale(Text(source, key), currency, locale) }); }
            var settled = value["settled"];
            Money(result.Realized, "Receitas realizadas", settled, "incomeMinor"); Money(result.Realized, "Despesas realizadas", settled, "expenseMinor");
            Money(result.Realized, "Resultado líquido", settled, "netMinor"); Money(result.Realized, "Saldo antes do período", settled, "openingMinor");
            Money(result.Realized, "Saldo ao fim / até geração", settled, "closingMinor"); Money(result.Realized, "Saldo inicial declarado no período", settled, "baselineChangeMinor");
            var planning = value["planning"];
            Money(result.Planned, "Renda prevista · não recebida", planning, "predictedIncomeMinor"); Money(result.Planned, "A receber · não recebido", planning, "receivableMinor");
            Money(result.Planned, "Débitos agendados · não pagos", planning, "scheduledDebitMinor"); Money(result.Planned, "A pagar · não pago", planning, "payableMinor"); Money(result.Planned, "Fluxo líquido planejado", planning, "plannedNetMinor");
            foreach (string key in new[] { "income", "expense", "net" })
            {
                var metric = value["comparisons"]?[key]; string title = key == "income" ? "Receitas" : key == "expense" ? "Despesas" : "Resultado";
                Money(result.Comparisons, title + " · diferença absoluta", metric, "deltaMinor");
                string percentage = metric?["percentageBasisPoints"]?.Type == JTokenType.Null ? "Sem percentual: base anterior zero" : MoneyDisplay.Percentage(Text(metric, "percentageBasisPoints"), locale);
                result.Comparisons.Add(new ChronicleLine { Label = title + " · variação / base anterior absoluta", Value = percentage });
            }
            if (value["goal"] is JObject goal)
            {
                Money(result.Context, "Meta · atribuído realizado na geração", goal, "creditedMinor"); Money(result.Context, "Meta · déficit na geração", goal, "remainingMinor");
                if (goal["calculation"] is JObject calculation)
                {
                    string calculationCurrency = Text(calculation, "currency");
                    foreach (string scenario in new[] { "conservative", "planned" }) result.Context.Add(new ChronicleLine { Label = scenario == "conservative" ? "Renda adicional conservadora · cálculo registrado" : "Renda adicional planejada · cálculo registrado", Value = calculation[scenario]?["requiredGrossMinor"]?.Type == JTokenType.Null ? "Não disponível" : MoneyDisplay.FormatLocale(Text(calculation[scenario], "requiredGrossMinor"), calculationCurrency, locale) });
                    result.Context.Add(new ChronicleLine { Label = "Horizonte próprio do cálculo de renda", Value = Text(calculation, "from") + " a " + Text(calculation, "through") + " · " + Text(calculation, "timezone") + " · registrado em " + Text(calculation, "asOf"), Financial = false });
                    if (calculation["stale"]?.Type != JTokenType.Boolean) throw new MobileFailure(Failure.Protocol);
                    result.Context.Add(new ChronicleLine { Label = "Cálculo de renda", Value = (bool)calculation["stale"] ? "Fontes mudaram · cálculo anterior preservado" : "Referências compatíveis na geração", Financial = false });
                }
            }
            if (value["reserve"] is JObject reserve) Money(result.Context, "Reserva declarada · atribuído na geração", reserve, "creditedMinor");
            if (value["work"] is JObject work)
            {
                string workCurrency = Text(work, "currency");
                result.Context.Add(new ChronicleLine { Label = "Capacidade declarada · cenário sobre datas do relatório", Value = work["totalMinor"]?.Type == JTokenType.Null ? "Não disponível" : MoneyDisplay.FormatLocale(Text(work, "totalMinor"), workCurrency, locale) });
                Money(result.Context, "Receita realizada menos capacidade declarada", work, "incomeMinusCapacityMinor");
            }
            var game = value["game"];
            result.Context.Add(new ChronicleLine { Label = "XP virtual recebido no período", Value = LongInteger(game, "xpGained").ToString(), Financial = false });
            result.Context.Add(new ChronicleLine { Label = "Missões concluídas no período", Value = Integer(game, "missionsCompleted").ToString(), Financial = false });
            result.Context.Add(new ChronicleLine { Label = "Nível na geração", Value = LongInteger(game, "level").ToString(), Financial = false });
            return result;
        }
        public async Task<ChronicleView> ReadChronicle(string access, string id, CancellationToken cancellation)
        {
            if (!Guid.TryParseExact(id, "D", out _)) throw new MobileFailure(Failure.Protocol);
            var result = Chronicle(await Send("v1/reports/chronicles/" + id, access, null, cancellation, report: true));
            if (result.Item.Id != id) throw new MobileFailure(Failure.Protocol); return result;
        }
        public async Task<ChronicleView> CreateChronicle(string access, ChronicleRequest request, string key, CancellationToken cancellation)
        {
            if (!Guid.TryParseExact(request.AccountId, "D", out _) || !Guid.TryParseExact(key, "D", out _) || (request.Type != "DAILY" && request.Type != "WEEKLY" && request.Type != "MONTHLY" && request.Type != "CUSTOM")) throw new MobileFailure(Failure.Protocol);
            var result = Chronicle(await Send("v1/reports/" + request.Type.ToLowerInvariant(), access, new JObject { ["idempotencyKey"] = key, ["accountId"] = request.AccountId, ["from"] = request.From, ["through"] = request.Through }, cancellation, bounded: true, report: true));
            if (result.Item.Id != key || result.Item.AccountId != request.AccountId || result.Item.Type != request.Type) throw new MobileFailure(Failure.Protocol); return result;
        }
        public void Dispose() => client.Dispose();
    }
}
