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
    }
    public interface IAuthorizationBrowser
    {
        Task<string> Authorize(string address, string scheme, CancellationToken cancellation);
        void Cancel();
    }
}
