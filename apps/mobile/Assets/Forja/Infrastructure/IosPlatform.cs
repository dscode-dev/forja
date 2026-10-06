using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Forja.Application;
using Forja.Core;
using UnityEngine;

namespace Forja.Infrastructure
{
    internal static class IosNative
    {
#if UNITY_IOS && !UNITY_EDITOR
        [DllImport("__Internal")] internal static extern int ForjaCredentialWrite(string value);
        [DllImport("__Internal")] internal static extern IntPtr ForjaCredentialRead(out int status);
        [DllImport("__Internal")] internal static extern int ForjaCredentialDelete();
        [DllImport("__Internal")] internal static extern void ForjaFree(IntPtr value);
        [DllImport("__Internal")] internal static extern int ForjaAuthStart(string url, string scheme);
        [DllImport("__Internal")] internal static extern IntPtr ForjaAuthPoll(out int status);
        [DllImport("__Internal")] internal static extern void ForjaAuthCancel();
        [DllImport("__Internal")] internal static extern void ForjaPrivacy(int hidden);
#else
        internal static int ForjaCredentialWrite(string value) => -1;
        internal static IntPtr ForjaCredentialRead(out int status) { status = -1; return IntPtr.Zero; }
        internal static int ForjaCredentialDelete() => -1;
        internal static void ForjaFree(IntPtr value) { }
        internal static int ForjaAuthStart(string url, string scheme) => -1;
        internal static IntPtr ForjaAuthPoll(out int status) { status = -1; return IntPtr.Zero; }
        internal static void ForjaAuthCancel() { }
        internal static void ForjaPrivacy(int hidden) { }
#endif
        internal static string Take(IntPtr value)
        { try { return value == IntPtr.Zero ? null : Marshal.PtrToStringAnsi(value); } finally { if (value != IntPtr.Zero) ForjaFree(value); } }
    }
    public sealed class IosCredentialStore : ISessionCredentialStore
    {
        private const string Marker = "forja.installation.v1";
        private bool initialized;
        private void Initialize()
        {
            if (initialized) return;
            if (!PlayerPrefs.HasKey(Marker))
            {
                Check(IosNative.ForjaCredentialDelete());
                PlayerPrefs.SetString(Marker, Guid.NewGuid().ToString("D")); PlayerPrefs.Save();
            }
            initialized = true;
        }
        private static void Check(int status) { if (status != 0) throw new MobileFailure(Failure.Configuration); }
        public Task<string> ReadAsync(CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested(); Initialize();
            var pointer = IosNative.ForjaCredentialRead(out var status);
            var result = IosNative.Take(pointer); Check(status);
            return Task.FromResult(result);
        }
        public Task WriteAsync(string credential, CancellationToken cancellation)
        { cancellation.ThrowIfCancellationRequested(); Initialize(); Check(IosNative.ForjaCredentialWrite(credential)); return Task.CompletedTask; }
        public Task DeleteAsync(CancellationToken cancellation)
        { cancellation.ThrowIfCancellationRequested(); Check(IosNative.ForjaCredentialDelete()); return Task.CompletedTask; }
    }
    public sealed class IosAuthorizationBrowser : IAuthorizationBrowser
    {
        public async Task<string> Authorize(string address, string scheme, CancellationToken cancellation)
        {
            if (IosNative.ForjaAuthStart(address, scheme) != 0) throw new MobileFailure(Failure.Configuration);
            try
            {
                while (true)
                {
                    cancellation.ThrowIfCancellationRequested();
                    var result = IosNative.Take(IosNative.ForjaAuthPoll(out var status));
                    if (status == 1) return result;
                    if (status < 0) throw new OperationCanceledException();
                    await Task.Delay(40, cancellation);
                }
            }
            finally { Cancel(); }
        }
        public void Cancel() => IosNative.ForjaAuthCancel();
        public static void Cover(bool hidden) => IosNative.ForjaPrivacy(hidden ? 1 : 0);
    }
}
