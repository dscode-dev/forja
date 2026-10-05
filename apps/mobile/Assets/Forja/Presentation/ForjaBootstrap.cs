using UnityEngine;

namespace Forja.Presentation
{
    public sealed class ForjaBootstrap : MonoBehaviour
    {
        private void Awake()
        {
            UnityEngine.Application.targetFrameRate = 60;
            Debug.Log("Forja bootstrap initialized.");
        }
    }
}
