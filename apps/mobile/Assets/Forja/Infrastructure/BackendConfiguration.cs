using Forja.Core;
using UnityEngine;

namespace Forja.Infrastructure
{
    [CreateAssetMenu(menuName = "Forja/Backend configuration")]
    public sealed class BackendConfiguration : ScriptableObject
    {
        [SerializeField] private string environment = "development";
        [SerializeField] private string backendOrigin = string.Empty;
        [SerializeField] private string oidcIssuer = string.Empty;
        [SerializeField] private string oidcClientId = string.Empty;
        [SerializeField] private string redirectUri = "com.darlan.forja.dev:/auth/callback";
        public MobileSettings ReadSettings() => new MobileSettings(environment, backendOrigin, oidcIssuer, oidcClientId, redirectUri);
        public ApiEndpoint ReadEndpoint() => new ApiEndpoint(backendOrigin);
    }
}
