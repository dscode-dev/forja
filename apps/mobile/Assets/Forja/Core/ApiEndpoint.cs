using System;

namespace Forja.Core
{
    public sealed class ApiEndpoint
    {
        public Uri BaseUri { get; }
        public ApiEndpoint(string address)
        {
            if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) ||
                uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo) ||
                !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
                throw new ArgumentException("An HTTPS backend origin is required.", nameof(address));
            BaseUri = uri;
        }
    }
}
