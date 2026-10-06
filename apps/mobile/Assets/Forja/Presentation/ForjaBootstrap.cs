using System;
using System.Collections;
using System.Threading.Tasks;
using Forja.Application;
using Forja.Core;
using Forja.Infrastructure;
using UnityEngine;
using UnityEngine.UIElements;

namespace Forja.Presentation
{
    public sealed class ForjaBootstrap : MonoBehaviour
    {
        private SessionCoordinator session;
        private BackendApi api;
        private VisualElement root;
        private ForjaShell shell;
        private readonly ShellNavigation navigation = new ShellNavigation();
        private PanelSettings panelSettings;
        private bool failed;
        private Coroutine reveal;
        private void Awake()
        {
            UnityEngine.Application.targetFrameRate = 60;
            var settings = ScriptableObject.CreateInstance<PanelSettings>(); panelSettings = settings;
            settings.scaleMode = PanelScaleMode.ScaleWithScreenSize; settings.referenceResolution = new Vector2Int(390, 844);
            var document = gameObject.AddComponent<UIDocument>(); document.panelSettings = settings;
            root = document.rootVisualElement;
            root.style.flexGrow = 1;
            root.style.unityFontDefinition = FontDefinition.FromFont(Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf"));
            shell = new ForjaShell(root, navigation, intent => Observe(session.Login(intent)),
                () => Observe(session.State == SessionState.AUTHENTICATED ? session.Reload() : session.Start()),
                all => Observe(session.Logout(all)));
            root.RegisterCallback<GeometryChangedEvent>(_ => ApplySafeArea());
            try
            {
                var configuration = Resources.Load<BackendConfiguration>("ForjaEnvironment");
                if (configuration == null) throw new MobileFailure(Failure.Configuration);
                var config = configuration.ReadSettings();
                api = new BackendApi(config.Endpoint);
                session = new SessionCoordinator(api, new IosCredentialStore(), new IosAuthorizationBrowser(), config);
                session.Changed += Render;
                Render(); Observe(session.Start());
            }
            catch { failed = true; Render(); }
        }
        private void Observe(Task operation)
        {
            // Coordinator consumes operational failures; never emit private exception objects.
            _ = ObserveCompletion(operation);
        }
        private async Task ObserveCompletion(Task operation)
        { try { await operation; } catch { failed = true; Render(); } }
        private void Render()
        {
            if (root == null || shell == null) return;
            try { shell.Render(session, failed); }
            finally { RevealAfterRender(); }
        }
        private Rect lastSafeArea;
        private int lastWidth, lastHeight;
        private void Update()
        {
            if (lastSafeArea != Screen.safeArea || lastWidth != Screen.width || lastHeight != Screen.height)
                ApplySafeArea();
        }
        private void ApplySafeArea()
        {
            if (root == null || Screen.width == 0 || root.resolvedStyle.width <= 0) return;
            lastSafeArea = Screen.safeArea; lastWidth = Screen.width; lastHeight = Screen.height;
            float scale = root.resolvedStyle.width / Screen.width;
            root.style.paddingLeft = lastSafeArea.xMin * scale;
            root.style.paddingRight = (Screen.width - lastSafeArea.xMax) * scale;
            root.style.paddingTop = (Screen.height - lastSafeArea.yMax) * scale;
            root.style.paddingBottom = lastSafeArea.yMin * scale;
        }
        private void RevealAfterRender()
        {
            if (reveal != null) StopCoroutine(reveal);
            reveal = StartCoroutine(RevealFrame());
        }
        private IEnumerator RevealFrame()
        {
            // UIKit may become active after Unity's focus callback. Release only a drawn safe frame.
            yield return new WaitForEndOfFrame();
            IosAuthorizationBrowser.Cover(false);
            reveal = null;
        }
        private void Hide()
        {
            if (reveal != null) { StopCoroutine(reveal); reveal = null; }
            IosAuthorizationBrowser.Cover(true);
        }
        private void OnApplicationPause(bool paused)
        {
            if (paused) { Hide(); session?.Background(); }
            else if (session != null) Observe(session.Foreground());
            else Render();
        }
        private void OnApplicationFocus(bool focused)
        { if (!focused) { Hide(); session?.Background(); }
            else if (session != null) Observe(session.Foreground());
            else Render(); }
        private void OnDestroy()
        { if (reveal != null) StopCoroutine(reveal); session?.Dispose(); api?.Dispose(); root?.Clear(); shell = null; if (panelSettings != null) Destroy(panelSettings); }
    }
}
