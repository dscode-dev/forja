using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Forja.Core
{
    public enum SessionState { BOOTSTRAPPING, UNAUTHENTICATED, AUTHENTICATING, AUTHENTICATED, SESSION_EXPIRED, DEGRADED, FATAL_CONFIGURATION_ERROR }
    public enum Failure { Offline, Timeout, Unauthorized, StepUp, Unavailable, Protocol, Configuration, Cancelled }
    public sealed class MobileFailure : Exception
    {
        public Failure Kind { get; }
        public MobileFailure(Failure kind) : base("Mobile operation failed.") { Kind = kind; }
    }
    public sealed class MobileSettings
    {
        public readonly ApiEndpoint Endpoint;
        public readonly string Environment, Issuer, ClientId, Redirect;
        public bool OidcConfigured => Issuer.Length > 0;
        public MobileSettings(string environment, string endpoint, string issuer, string clientId, string redirect)
        {
            if (environment != "development" && environment != "production") throw new MobileFailure(Failure.Configuration);
            Endpoint = new ApiEndpoint(endpoint);
            if (Endpoint.BaseUri.AbsolutePath != "/") throw new MobileFailure(Failure.Configuration);
            Environment = environment; Issuer = issuer ?? ""; ClientId = clientId ?? ""; Redirect = redirect ?? "";
            if (Redirect != "com.darlan.forja.dev:/auth/callback") throw new MobileFailure(Failure.Configuration);
            if ((Issuer.Length == 0) != (ClientId.Length == 0)) throw new MobileFailure(Failure.Configuration);
            if (OidcConfigured && (!Uri.TryCreate(Issuer, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0 || ClientId.Length > 256))
                throw new MobileFailure(Failure.Configuration);
            if (environment == "production" && !OidcConfigured) throw new MobileFailure(Failure.Configuration);
        }
    }
    public sealed class AuthChallenge
    {
        public string Id, State, Nonce, AuthorizationUrl;
        public int ExpiresIn;
    }
    public sealed class Tokens
    {
        public string Access, Refresh;
        public int ExpiresIn;
        public void Validate()
        {
            if (!Regex.IsMatch(Access ?? "", "^[A-Za-z0-9_-]{43}$") || !Regex.IsMatch(Refresh ?? "", "^[A-Za-z0-9_-]{43}$") || ExpiresIn != 300)
                throw new MobileFailure(Failure.Protocol);
        }
    }
    public sealed class ShellSnapshot
    {
        public string Name;
        public readonly List<AccountView> Accounts = new List<AccountView>();
        public WorkView Work;
        public readonly List<GoalView> Goals = new List<GoalView>();
        public string AccountNext, GoalNext;
        public ForecastView Forecast;
    }
    public sealed class AccountView
    {
        public string Id, Name, Balance, State, Currency;
    }
    public sealed class ForecastView
    {
        public string AccountId, AccountName, AsOf, Through, Projected, Receivable, Payable, PredictedIncome, ScheduledDebit;
    }
    public sealed class WorkView
    {
        public string Occupation, From, Through, Estimate;
    }
    public sealed class GoalView
    {
        public string Id, Title, State, Target, Credited, Remaining;
    }
    public enum FinancialMeaning { Settled, Projected, Receivable, Payable, GoalFunding, WorkCapacity }
    public static class FinancialLabels
    {
        public static string Title(FinancialMeaning meaning)
        {
            switch (meaning)
            {
                case FinancialMeaning.Settled: return "Saldo realizado";
                case FinancialMeaning.Projected: return "Saldo projetado · estimativa";
                case FinancialMeaning.Receivable: return "A receber · ainda não recebido";
                case FinancialMeaning.Payable: return "A pagar · ainda não pago";
                case FinancialMeaning.GoalFunding: return "Atribuído à meta · recursos realizados";
                case FinancialMeaning.WorkCapacity: return "Capacidade declarada · estimativa";
                default: throw new ArgumentOutOfRangeException(nameof(meaning));
            }
        }
        public static string Value(string formatted, bool hidden) => hidden ? "••••" : formatted;
    }
    public static class Pkce
    {
        public static string Verifier()
        {
            var bytes = new byte[32]; using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            return Encode(bytes);
        }
        public static string Challenge(string verifier)
        { using (var hash = SHA256.Create()) return Encode(hash.ComputeHash(Encoding.ASCII.GetBytes(verifier))); }
        private static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        public static void Authorization(AuthChallenge flow, MobileSettings settings, string verifier)
        {
            if (!Uri.TryCreate(flow.AuthorizationUrl, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.UserInfo.Length > 0 || uri.Fragment.Length > 0 || uri.GetLeftPart(UriPartial.Authority) != new Uri(settings.Issuer).GetLeftPart(UriPartial.Authority)) throw new MobileFailure(Failure.Protocol);
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string part in uri.Query.TrimStart('?').Split('&'))
            {
                var pair = part.Split(new[] { '=' }, 2);
                if (pair.Length != 2) throw new MobileFailure(Failure.Protocol);
                string key = Uri.UnescapeDataString(pair[0]);
                if (fields.ContainsKey(key)) throw new MobileFailure(Failure.Protocol);
                fields.Add(key, Uri.UnescapeDataString(pair[1].Replace("+", " ")));
            }
            var required = new Dictionary<string, string> { ["client_id"] = settings.ClientId, ["redirect_uri"] = settings.Redirect, ["state"] = flow.State, ["nonce"] = flow.Nonce, ["code_challenge"] = Challenge(verifier), ["code_challenge_method"] = "S256", ["response_type"] = "code" };
            foreach (var field in required) if (!fields.TryGetValue(field.Key, out var value) || value != field.Value) throw new MobileFailure(Failure.Protocol);
        }
        public static string Code(string callback, string redirect, string expectedState)
        {
            if (callback == null || callback.Length > 8192 || !Uri.TryCreate(callback, UriKind.Absolute, out var uri) ||
                uri.GetLeftPart(UriPartial.Path) != redirect || uri.Fragment.Length > 0 || uri.UserInfo.Length > 0)
                throw new MobileFailure(Failure.Protocol);
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var part in uri.Query.TrimStart('?').Split('&'))
            {
                var pair = part.Split(new[] { '=' }, 2);
                if (pair.Length != 2) throw new MobileFailure(Failure.Protocol);
                var key = Uri.UnescapeDataString(pair[0]);
                if (values.ContainsKey(key)) throw new MobileFailure(Failure.Protocol);
                values.Add(key, Uri.UnescapeDataString(pair[1].Replace("+", " ")));
            }
            if (!values.TryGetValue("state", out var state) || state != expectedState) throw new MobileFailure(Failure.Protocol);
            if (values.ContainsKey("error")) throw new MobileFailure(Failure.Unauthorized);
            if (!values.TryGetValue("code", out var code) || code.Length == 0 || code.Length > 2048) throw new MobileFailure(Failure.Protocol);
            return code;
        }
    }
    public static class MoneyDisplay
    {
        public static string Format(string minor, string currency, int digits)
        {
            var expected = currency == "JPY" ? 0 : currency == "KWD" ? 3 : currency == "BRL" || currency == "USD" || currency == "EUR" ? 2 : -1;
            if (digits != expected || expected < 0 || !Regex.IsMatch(minor ?? "", "^(0|-?[1-9][0-9]{0,17})$")) throw new MobileFailure(Failure.Protocol);
            bool negative = minor[0] == '-'; string value = negative ? minor.Substring(1) : minor;
            value = value.PadLeft(digits + 1, '0');
            return currency + " " + (negative ? "−" : "") + (digits == 0 ? value : value.Substring(0, value.Length - digits) + "," + value.Substring(value.Length - digits));
        }
        public static int Digits(string currency) => currency == "JPY" ? 0 : currency == "KWD" ? 3 : 2;
    }
}
