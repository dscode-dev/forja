using System.Threading;
using System.Threading.Tasks;
using Forja.Core;

namespace Forja.Application
{
    public interface IBackendApi
    {
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
