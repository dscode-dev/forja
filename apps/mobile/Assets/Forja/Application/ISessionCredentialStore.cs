#nullable enable
using System.Threading;
using System.Threading.Tasks;

namespace Forja.Application
{
    // Only the rotating refresh credential; access and API payloads remain in memory.
    public interface ISessionCredentialStore
    {
        Task<string?> ReadAsync(CancellationToken cancellationToken);
        Task WriteAsync(string credential, CancellationToken cancellationToken);
        Task DeleteAsync(CancellationToken cancellationToken);
    }
}
