#nullable enable
using System.Threading;
using System.Threading.Tasks;

namespace Forja.Application
{
    // Refresh credentials only; native secure-storage adapter belongs to PR-06.
    public interface ISessionCredentialStore
    {
        Task<string?> ReadAsync(CancellationToken cancellationToken);
        Task WriteAsync(string credential, CancellationToken cancellationToken);
        Task DeleteAsync(CancellationToken cancellationToken);
    }
}
