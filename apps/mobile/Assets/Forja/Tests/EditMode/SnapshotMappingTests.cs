using System;
using System.Net;
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
        private sealed class Handler : HttpMessageHandler
        {
            public int SummaryStatus = 200;
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
                else throw new InvalidOperationException("Unexpected fixture route.");
                var response = new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(body) };
                response.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
                response.Headers.CacheControl = new CacheControlHeaderValue { NoStore=true };
                return Task.FromResult(response);
            }
        }
    }
}
