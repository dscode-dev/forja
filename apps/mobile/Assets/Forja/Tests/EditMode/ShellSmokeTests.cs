using System.Collections;
using System.Linq;
using Forja.Presentation;
using Forja.Infrastructure;
using NUnit.Framework;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;

namespace Forja.Tests
{
    public sealed class ShellSmokeTests
    {
        [UnityTest]
        public IEnumerator BootstrapHasSafeShellInPlayMode()
        {
            bool missingConfiguration = false;
            try { Resources.Load<BackendConfiguration>("ForjaEnvironment").ReadSettings(); }
            catch { missingConfiguration = true; }
            EditorSceneManager.OpenScene("Assets/Forja/Scenes/Bootstrap.unity");
            yield return new EnterPlayMode();
            yield return null;
            var bootstrap = Object.FindFirstObjectByType<ForjaBootstrap>();
            Assert.That(bootstrap, Is.Not.Null);
            var document = bootstrap.GetComponent<UIDocument>();
            Assert.That(document, Is.Not.Null);
            var labels = document.rootVisualElement.Query<Label>().ToList();
            Assert.That(labels.Any(label => label.text == "Forja"), Is.True);
            if (missingConfiguration)
                Assert.That(labels.Any(label => label.text == "A conexão do aplicativo ainda precisa ser configurada."), Is.True);
            if (missingConfiguration)
            {
                for (int cycle = 0; cycle < 3; cycle++)
                {
                    bootstrap.SendMessage("OnApplicationFocus", false);
                    bootstrap.SendMessage("OnApplicationPause", true);
                    yield return null;
                    bootstrap.SendMessage("OnApplicationFocus", true);
                    bootstrap.SendMessage("OnApplicationPause", false);
                    yield return null;
                    labels = document.rootVisualElement.Query<Label>().ToList();
                    Assert.That(labels.Any(label => label.text == "A conexão do aplicativo ainda precisa ser configurada."), Is.True);
                }
            }
            LogAssert.NoUnexpectedReceived();
            yield return new ExitPlayMode();
        }
    }
}
