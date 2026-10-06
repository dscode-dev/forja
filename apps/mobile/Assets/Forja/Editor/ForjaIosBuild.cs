#if UNITY_EDITOR
using System;
using System.IO;
using UnityEditor;
using UnityEditor.Callbacks;
using UnityEditor.iOS.Xcode;
using UnityEditor.Build.Reporting;

namespace Forja.Editor
{
    public static class ForjaIosBuild
    {
        [PostProcessBuild(100)]
        public static void Configure(BuildTarget target, string path)
        {
            if (target != BuildTarget.iOS) return;
            var plist = new PlistDocument(); string file = Path.Combine(path, "Info.plist"); plist.ReadFromFile(file);
            var urls = plist.root.CreateArray("CFBundleURLTypes");
            var url = urls.AddDict(); url.SetString("CFBundleURLName", "Forja authentication"); url.CreateArray("CFBundleURLSchemes").AddString("com.darlan.forja.dev");
            plist.WriteToFile(file);
            var project = new PBXProject(); string projectFile = PBXProject.GetPBXProjectPath(path); project.ReadFromFile(projectFile);
            string framework = project.GetUnityFrameworkTargetGuid();
            project.AddFrameworkToProject(framework, "AuthenticationServices.framework", false);
            project.AddFrameworkToProject(framework, "Security.framework", false);
            string plugin = project.FindFileGuidByProjectPath("Libraries/Forja/Plugins/iOS/ForjaPlatform.mm");
            if (string.IsNullOrEmpty(plugin)) throw new InvalidOperationException("Native authentication bridge missing from generated project.");
            project.SetCompileFlagsForFile(framework, plugin, new System.Collections.Generic.List<string> { "-fobjc-arc" });
            project.WriteToFile(projectFile);
        }
        public static void Build()
        {
            string output = Environment.GetEnvironmentVariable("FORJA_IOS_OUTPUT");
            if (string.IsNullOrEmpty(output)) throw new InvalidOperationException("FORJA_IOS_OUTPUT is required.");
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions { scenes = new[] { "Assets/Forja/Scenes/Bootstrap.unity" }, locationPathName = output, target = BuildTarget.iOS, options = BuildOptions.Development });
            if (report.summary.result != BuildResult.Succeeded) throw new InvalidOperationException("iOS generation failed.");
        }
    }
}
#endif
