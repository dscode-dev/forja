using Forja.Core;
using UnityEngine;

namespace Forja.Infrastructure
{
    [CreateAssetMenu(menuName = "Forja/Backend configuration")]
    public sealed class BackendConfiguration : ScriptableObject
    {
        [SerializeField] private string backendOrigin = string.Empty;
        public ApiEndpoint ReadEndpoint() => new ApiEndpoint(backendOrigin);
    }
}
