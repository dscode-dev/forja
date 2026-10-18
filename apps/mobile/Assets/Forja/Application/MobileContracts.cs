using System.Threading;
using System.Threading.Tasks;
using Forja.Core;

namespace Forja.Application
{
    public interface IBackendApi
    {
        Task<AiPreferences> ReadAiPreferences(string access, CancellationToken cancellation);
        Task<AiPreferences> SetAiPreferences(string access, AiPreferences previous, bool enabled, CancellationToken cancellation);
        Task<AiAnalysis> ReadAlquimista(string access, string reportId, CancellationToken cancellation);
        Task<AiAnalysis> RequestAlquimista(string access, string reportId, string key, string retryOf, CancellationToken cancellation);
        Task<StrategyView> ReadStrategy(string access, StrategyIntent intent, CancellationToken cancellation);
        Task<StrategyView> RequestStrategy(string access, StrategyIntent intent, string key, string retryOf, CancellationToken cancellation);
        Task DecideStrategy(string access, string executionId, bool accept, CancellationToken cancellation);
        Task Ready(CancellationToken cancellation);
        Task<AuthChallenge> Begin(string challenge, string intent, CancellationToken cancellation);
        Task<Tokens> Complete(AuthChallenge challenge, string verifier, string code, CancellationToken cancellation);
        Task<Tokens> Refresh(string refresh, CancellationToken cancellation);
        Task Revoke(string access, bool all, CancellationToken cancellation);
        Task<ShellSnapshot> Read(string access, CancellationToken cancellation);
        Task AssignMission(string access, MissionCandidate candidate, string key, CancellationToken cancellation);
        Task<ChronicleView> CreateChronicle(string access, ChronicleRequest request, string key, CancellationToken cancellation);
        Task<ChronicleView> ReadChronicle(string access, string id, CancellationToken cancellation);
        Task<ChroniclePage> ReadChronicles(string access, int after, CancellationToken cancellation);
        Task EvaluateMission(string access, string id, bool cancel, CancellationToken cancellation);
    }
    public interface IAuthorizationBrowser
    {
        Task<string> Authorize(string address, string scheme, CancellationToken cancellation);
        void Cancel();
    }
}
