#if UNITY_EDITOR
using System;
using UnityEditor;
using UnityEngine;
using Forja.Presentation;

namespace Forja.Editor
{
    public static class ForjaArtImport
    {
        // Explicit pipeline command; never changes an open developer Editor implicitly.
        public static void Prepare()
        {
            string folder = "Assets/Forja/Resources/UI/Art/";
            foreach (string name in new[] { "atelier", "male", "female" })
            {
                string path = folder + name + ".png";
                var importer = AssetImporter.GetAtPath(path) as TextureImporter;
                if (importer == null) throw new InvalidOperationException("Reviewed artwork missing: " + name);
                importer.textureType = TextureImporterType.Default; importer.textureShape = TextureImporterShape.Texture2D;
                importer.sRGBTexture = true; importer.mipmapEnabled = false; importer.isReadable = false;
                importer.npotScale = TextureImporterNPOTScale.None; importer.wrapMode = TextureWrapMode.Clamp;
                importer.filterMode = FilterMode.Bilinear; importer.maxTextureSize = 1024;
                importer.alphaIsTransparency = name != "atelier";
                importer.SetPlatformTextureSettings(new TextureImporterPlatformSettings { name = "iPhone", overridden = true, maxTextureSize = 1024, format = TextureImporterFormat.ASTC_6x6 });
                importer.SaveAndReimport();
            }
            string assetPath = "Assets/Forja/Resources/UI/PresentationArt.asset";
            var art = AssetDatabase.LoadAssetAtPath<PresentationArt>(assetPath);
            if (art == null) { art = ScriptableObject.CreateInstance<PresentationArt>(); AssetDatabase.CreateAsset(art, assetPath); }
            art.world = AssetDatabase.LoadAssetAtPath<Texture2D>(folder + "atelier.png");
            art.male = new CharacterArtwork { catalogueId = "male", neutral = AssetDatabase.LoadAssetAtPath<Texture2D>(folder + "male.png"), idleFrames = new Texture2D[0] };
            art.female = new CharacterArtwork { catalogueId = "female", neutral = AssetDatabase.LoadAssetAtPath<Texture2D>(folder + "female.png"), idleFrames = new Texture2D[0] };
            if (art.world == null || art.male.neutral == null || art.female.neutral == null) throw new InvalidOperationException("Imported 2D textures must resolve before catalogue save.");
            EditorUtility.SetDirty(art);
            PlayerSettings.defaultInterfaceOrientation = UIOrientation.Portrait;
            AssetDatabase.SaveAssets();
            Debug.Log("forja.art import=ok orientation=portrait texture_count=3 max_size=1024 ios_format=ASTC_6x6");
        }
    }
}
#endif
