using System.Threading;
using System.Threading.Tasks;
using Forja.Core;

namespace Forja.Application
{
    // Health transport boundary; binding/transport implementation belongs to PR-06.
    public interface IBackendAvailability
    {
        Task<bool> IsReadyAsync(ApiEndpoint endpoint, CancellationToken cancellationToken);
    }
}
