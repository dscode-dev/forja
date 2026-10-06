using System;
using UnityEngine;

namespace Forja.Presentation
{
    [Serializable]
    public sealed class CharacterArtwork
    {
        public string catalogueId;
        public Texture2D neutral;
        public Texture2D warm;
        public Texture2D[] idleFrames;
    }
    [CreateAssetMenu(menuName = "Forja/Presentation Art")]
    public sealed class PresentationArt : ScriptableObject
    {
        public Texture2D world;
        public CharacterArtwork male;
        public CharacterArtwork female;
        public CharacterArtwork Find(string id) => id == "male" ? male : id == "female" ? female : null;
    }
}
