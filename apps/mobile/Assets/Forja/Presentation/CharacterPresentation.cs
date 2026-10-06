using System;
using UnityEngine;
using UnityEngine.UIElements;

namespace Forja.Presentation
{
    public enum CharacterExpression { Neutral, Warm }
    // Catalogue textures only. No financial/session state, persisted equipment or inferred gender.
    public sealed class CharacterPresentation : VisualElement
    {
        private readonly Image portrait;
        private readonly CharacterArtwork artwork;
        private readonly IVisualElementScheduledItem idle;
        private int frame;
        public CharacterPresentation(PresentationArt art, string id, bool reducedMotion)
        {
            AddToClassList("world");
            var backdrop = new Image { image = art == null ? null : art.world, scaleMode = ScaleMode.ScaleAndCrop };
            backdrop.AddToClassList("world-image"); backdrop.pickingMode = PickingMode.Ignore; Add(backdrop);
            artwork = art == null ? null : art.Find(id);
            portrait = new Image { image = artwork == null ? null : artwork.neutral, scaleMode = ScaleMode.ScaleToFit };
            portrait.AddToClassList("character-image"); portrait.pickingMode = PickingMode.Ignore; Add(portrait);
            var caption = ShellComponents.Text(artwork == null ? "Seu espaço para construir o amanhã" : "Um passo por vez", "world-caption"); Add(caption);
            if (!reducedMotion && artwork?.idleFrames != null && artwork.idleFrames.Length > 1)
                idle = schedule.Execute(() => { portrait.image = artwork.idleFrames[frame++ % artwork.idleFrames.Length]; }).Every(250);
            RegisterCallback<DetachFromPanelEvent>(_ => idle?.Pause());
        }
        public void Expression(CharacterExpression expression)
        { if (artwork != null) portrait.image = expression == CharacterExpression.Warm && artwork.warm != null ? artwork.warm : artwork.neutral; }
    }
}
