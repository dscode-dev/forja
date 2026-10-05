using System;
using Forja.Core;
using NUnit.Framework;

namespace Forja.Tests.EditMode
{
    public sealed class ApiEndpointTests
    {
        [TestCase("http://example.invalid")]
        [TestCase("https://credential@example.invalid")]
        [TestCase("https://example.invalid?secret=value")]
        [TestCase("invalid")]
        public void RejectsInsecureOrSecretBearingEndpoints(string address)
        {
            Assert.Throws<ArgumentException>(() => new ApiEndpoint(address));
        }
        [Test]
        public void AcceptsHttpsOrigin()
        {
            Assert.That(new ApiEndpoint("https://example.invalid").BaseUri.Scheme, Is.EqualTo("https"));
        }
    }
}
