using System;
using System.Net;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;
using Forja.Core;
using Forja.Infrastructure;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Forja.Tests
{
    public sealed class SnapshotMappingTests
    {
        [Test] public async Task RealWireShapeKeepsSettledAndEstimatedValuesSeparate()
        {
            using (var api = new BackendApi(new ApiEndpoint("https://api.example.test"), new Handler()))
            {
                var result = await api.Read("test-access", CancellationToken.None);
                Assert.That(result.Accounts[0].Balance, Is.EqualTo("BRL 123,45"));
                Assert.That(result.Forecast.Projected, Is.EqualTo("BRL 199,99"));
                Assert.That(result.Forecast.Receivable, Is.EqualTo("BRL 8,00"));
                Assert.That(result.Forecast.Payable, Is.EqualTo("BRL 4,00"));
                Assert.That(result.Goals[0].Credited, Is.EqualTo("BRL 12,00"));
                Assert.That(result.Goals[0].Remaining, Is.EqualTo("BRL 88,00"));
                Assert.That(result.Work, Is.Null);
            }
        }
        [Test] public async Task ForecastSafetyCapIsUnavailableNotZeroOrSettled()
        {
            using (var api = new BackendApi(new ApiEndpoint("https://api.example.test"), new Handler { SummaryStatus = 422 }))
            { var result = await api.Read("test-access", CancellationToken.None); Assert.That(result.Forecast, Is.Null); Assert.That(result.Accounts[0].Balance, Is.EqualTo("BRL 123,45")); }
        }
        [Test] public void CrossAccountForecastFailsClosed()
        {
            using (var api = new BackendApi(new ApiEndpoint("https://api.example.test"), new Handler { ForeignSummary = true }))
                Assert.ThrowsAsync<MobileFailure>(async () => await api.Read("test-access", CancellationToken.None));
        }
        [Test] public async Task ChronicleWireKeepsFactsPlannedAndVirtualXpSeparate()
        {
            var handler = new Handler();
            using (var api = new BackendApi(new ApiEndpoint("https://api.example.test"), handler))
            {
                var report = await api.ReadChronicle("test-access", "33333333-3333-4333-8333-333333333333", CancellationToken.None);
                Assert.That(report.Realized[0].Value, Is.EqualTo("BRL 7.00"));
                Assert.That(report.Planned[0].Value, Is.EqualTo("BRL 90.00"));
                Assert.That(report.Comparisons[1].Value, Does.Contain("base anterior zero"));
                Assert.That(report.Context[0].Financial, Is.False);
                Assert.That(report.Context[0].Value, Is.EqualTo("20"));
                var request = new ChronicleRequest { AccountId = "11111111-1111-4111-8111-111111111111", Type = "DAILY", From = "2026-03-08", Through = "2026-03-08" };
                await api.CreateChronicle("test-access", request, report.Item.Id, CancellationToken.None);
                var command = JObject.Parse(handler.ReportCommand);
                Assert.That(command.Properties().Select(p => p.Name), Is.EquivalentTo(new[] { "accountId", "idempotencyKey", "from", "through" }));
                Assert.That((string)command["from"], Is.EqualTo("2026-03-08"));
            }
        }
        [Test] public void ChronicleExpiryAndInvalidPeriodAreExplicitFailures()
        {
            foreach (int status in new[] { 400, 404 }) using (var api = new BackendApi(new ApiEndpoint("https://api.example.test"), new Handler { ReportStatus = status }))
            {
                var error = Assert.ThrowsAsync<MobileFailure>(async () => await api.ReadChronicle("test", "33333333-3333-4333-8333-333333333333", CancellationToken.None));
                Assert.That(error.Kind, Is.EqualTo(status == 400 ? Failure.InvalidPeriod : Failure.ChronicleExpired));
            }
        }
        [Test] public void ExactLocaleDisplayPreservesPrecisionAndLargePercentage()
        {
            Assert.That(MoneyDisplay.FormatLocale("123456789012345678", "KWD", "en-US"), Is.EqualTo("KWD 123,456,789,012,345.678"));
            Assert.That(MoneyDisplay.FormatLocale("-12345", "BRL", "pt-BR"), Is.EqualTo("BRL -123,45"));
            Assert.That(MoneyDisplay.Percentage("9999999999999999990000", "en-US"), Is.EqualTo("99,999,999,999,999,999,900.00%"));
        }
        [Test] public async Task ChronicleOldCalculationKeepsItsOwnCurrencyAndHorizon()
        {
            using (var api = new BackendApi(new ApiEndpoint("https://api.example.test"), new Handler { WithCalculation = true }))
            {
                var report = await api.ReadChronicle("test", "33333333-3333-4333-8333-333333333333", CancellationToken.None);
                Assert.That(report.Context.Find(x => x.Label.Contains("Renda adicional conservadora")).Value, Is.EqualTo("USD 12.34"));
                Assert.That(report.Context.Find(x => x.Label.Contains("Horizonte próprio")).Value, Does.Contain("2027-01-01"));
            }
        }
        [Test] public async Task StrategyWireSeparatesFactsProposalAndUserCommandWithoutInventedCoverage()
        {
            var handler = new StrategyHandler();
            using (var api = new BackendApi(new ApiEndpoint("https://api.example.test"), handler))
            {
                var intent = new StrategyIntent { GoalId = "11111111-1111-4111-8111-111111111111", Focus = "RESERVE" };
                var value = await api.ReadStrategy("test-access", intent, CancellationToken.None);
                Assert.That(value.ProposalTitle, Is.EqualTo("Test-only reserve mission")); Assert.That(value.RewardXp, Is.EqualTo(50)); Assert.That(value.Evidence[0].Value, Is.EqualTo("BRL 0,00"));
                Assert.That(handler.Posts, Is.Zero); await api.RequestStrategy("test-access", intent, "22222222-2222-4222-8222-222222222222", null, CancellationToken.None); Assert.That(handler.Posts, Is.EqualTo(1));
                var body = BackendApi.Parse(handler.Command); Assert.That(body["intent"]["goalId"].ToString(), Is.EqualTo(intent.GoalId)); Assert.That(body.Property("xp"), Is.Null);
                await api.DecideStrategy("test-access", value.ExecutionId, true, CancellationToken.None); Assert.That(handler.Command, Is.EqualTo("{}"));
            }
        }
        private sealed class StrategyHandler : HttpMessageHandler
        {
            public int Posts; public string Command;
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
            {
                if (request.Method == HttpMethod.Post) { Posts++; Command = request.Content.ReadAsStringAsync().GetAwaiter().GetResult(); }
                JToken Nil() => JValue.CreateNull();
                var body = request.RequestUri.AbsolutePath.EndsWith("/accept", StringComparison.Ordinal) ? new JObject { ["id"] = "33333333-3333-4333-8333-333333333333" } : new JObject {
                    ["state"] = "SUCCEEDED", ["cached"] = true, ["executionId"] = "22222222-2222-4222-8222-222222222222", ["decision"] = Nil(),
                    ["narrative"] = new JObject { ["schema"] = 1, ["kind"] = "AI_STRATEGY", ["method"] = "MODEL_SELECTED_REVIEWED_TEXT", ["summary"] = new JObject { ["text"] = "Test-only source-grounded strategy" }, ["focus"] = new JObject { ["text"] = "Test-only focus" }, ["limitations"] = new JArray("Test-only unknown coverage") },
                    ["proposal"] = new JObject { ["template"] = "RESERVE_TARGET", ["version"] = 1, ["title"] = "Test-only reserve mission", ["rewardXp"] = 50, ["rationale"] = new JObject { ["text"] = "Test-only rationale" } },
                    ["evidence"] = new JObject { ["currency"] = "BRL", ["settledMinor"] = "0", ["goalRemainingMinor"] = "10000", ["pendingOutgoingMinor"] = "0", ["pendingIncomingMinor"] = "9000", ["expenseBaseline"] = Nil(), ["coverageDays"] = Nil(), ["idealReserveTarget"] = Nil() } };
                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body.ToString()) }; response.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json"); response.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true }; return Task.FromResult(response);
            }
        }
        private sealed class Handler : HttpMessageHandler
        {
            public int SummaryStatus = 200, ReportStatus = 200;
            public string ReportCommand; public bool WithCalculation;
            public bool ForeignSummary;
            private const string Account = "11111111-1111-4111-8111-111111111111";
            private const string Goal = "22222222-2222-4222-8222-222222222222";
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
            {
                string path = request.RequestUri.AbsolutePath;
                string body; int status = 200;
                if (path == "/v1/me") body = "{\"userId\":\""+Account+"\",\"revision\":1,\"displayName\":null}";
                else if (path == "/v1/finance/accounts") body = "{\"rule\":1,\"next\":null,\"accounts\":[{\"id\":\""+Account+"\",\"name\":\"test account\",\"currency\":\"BRL\",\"minorDigits\":2,\"state\":\"active\",\"balanceMinor\":\"12345\"}]}";
                else if (path == "/v1/planning/expected/summary")
                {
                    status = SummaryStatus;
                    string query = request.RequestUri.Query;
                    string through = Uri.UnescapeDataString(query.Substring(query.IndexOf("through=", StringComparison.Ordinal)+8));
                    body = new JObject { ["rule"]=1,["accountId"]=ForeignSummary?Goal:Account,["currency"]="BRL",["through"]=through,["asOf"]="2026-10-06T12:00:00.000Z",["projectedBalanceMinor"]="19999",["receivableMinor"]="800",["payableMinor"]="400",["predictedIncomeMinor"]="7254",["scheduledDebitMinor"]="0" }.ToString();
                }
                else if (path == "/v1/work/profile") { status=404; body="{}"; }
                else if (path == "/v1/planning/goals") body="{\"next\":null,\"goals\":[{\"id\":\""+Goal+"\",\"revision\":1,\"status\":\"ACTIVE\",\"goal\":{\"currency\":\"BRL\",\"title\":\"test goal\",\"targetMinor\":\"10000\"}}]}";
                else if (path == "/v1/planning/goals/"+Goal+"/progress") body="{\"goalId\":\""+Goal+"\",\"goalRevision\":1,\"currency\":\"BRL\",\"creditedMinor\":\"1200\",\"remainingMinor\":\"8800\"}";
                else if (path == "/v1/game/progression") body = "{\"curveVersion\":1,\"xp\":0,\"level\":1,\"nextLevelXp\":100,\"xpToNextLevel\":100}";
                else if (path == "/v1/game/missions") body = "{\"missions\":[],\"next\":null}";
                else if (path == "/v1/game/candidates") body = "{\"candidates\":[]}";
                else if (path == "/v1/reports/periods") body = "{\"reportVersion\":1,\"today\":\"2026-10-17\",\"timezone\":\"America/Recife\",\"locale\":\"pt-BR\"}";
                else if (path == "/v1/reports/chronicles") body = "{\"chronicles\":[],\"next\":null}";
                else if (path.StartsWith("/v1/reports/", StringComparison.Ordinal))
                {
                    status = ReportStatus;
                    if (request.Content != null) ReportCommand = request.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                    var zero = new JObject { ["deltaMinor"] = "0", ["percentageBasisPoints"] = JValue.CreateNull() };
                    body = new JObject { ["id"] = "33333333-3333-4333-8333-333333333333", ["generation"] = 1, ["reportVersion"] = 1, ["locale"] = "en-US", ["generatedAt"] = "2026-03-09T12:00:00.000Z", ["expiresAt"] = "2026-03-16T12:00:00.000Z",
                        ["request"] = new JObject { ["accountId"] = Account }, ["finance"] = new JObject { ["currency"] = "BRL" },
                        ["period"] = new JObject { ["type"] = "DAILY", ["timezone"] = "America/New_York", ["partial"] = false, ["current"] = new JObject { ["from"] = "2026-03-08", ["through"] = "2026-03-08" } },
                        ["settled"] = new JObject { ["incomeMinor"] = "700", ["expenseMinor"] = "250", ["netMinor"] = "450", ["openingMinor"] = "1300", ["closingMinor"] = "1750", ["baselineChangeMinor"] = "0" },
                        ["planning"] = new JObject { ["predictedIncomeMinor"] = "9000", ["receivableMinor"] = "0", ["payableMinor"] = "0", ["scheduledDebitMinor"] = "0", ["plannedNetMinor"] = "9000" },
                        ["comparisons"] = new JObject { ["income"] = zero.DeepClone(), ["expense"] = zero.DeepClone(), ["net"] = zero.DeepClone() }, ["goal"] = WithCalculation ? new JObject { ["creditedMinor"] = "100", ["remainingMinor"] = "999", ["calculation"] = new JObject { ["currency"] = "USD", ["from"] = "2026-01-01", ["through"] = "2027-01-01", ["timezone"] = "UTC", ["asOf"] = "2026-01-01T00:00:00.000Z", ["stale"] = true, ["conservative"] = new JObject { ["requiredGrossMinor"] = "1234" }, ["planned"] = new JObject { ["requiredGrossMinor"] = "987" } } } : JValue.CreateNull(), ["work"] = JValue.CreateNull(), ["reserve"] = JValue.CreateNull(),
                        ["game"] = new JObject { ["xpGained"] = 20, ["missionsCompleted"] = 1, ["level"] = 1 } }.ToString();
                }
                else throw new InvalidOperationException("Unexpected fixture route.");
                var response = new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(body) };
                response.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
                response.Headers.CacheControl = new CacheControlHeaderValue { NoStore=true };
                return Task.FromResult(response);
            }
        }
    }
}
