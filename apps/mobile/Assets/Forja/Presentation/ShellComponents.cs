using System;
using Forja.Core;
using UnityEngine.UIElements;

namespace Forja.Presentation
{
    // Concrete UI Toolkit surfaces. Private values never become retained templates or tooltips.
    public static class ShellComponents
    {
        public static Label Text(string text, string style = "body")
        {
            var label = new Label(text) { enableRichText = false };
            label.AddToClassList(style); return label;
        }
        public static VisualElement Panel(string title, string eyebrow = null)
        {
            var panel = new VisualElement(); panel.AddToClassList("panel");
            if (eyebrow != null) panel.Add(Text(eyebrow, "eyebrow"));
            panel.Add(Text(title, "heading")); return panel;
        }
        public static Button Action(string title, Action action, bool enabled = true, string style = "action")
        {
            var button = new Button(action) { text = title }; button.AddToClassList(style);
            button.SetEnabled(enabled); return button;
        }
        public static void Value(VisualElement parent, string label, string value, bool hidden)
        {
            parent.Add(Text(label, "caption"));
            parent.Add(Text(FinancialLabels.Value(value, hidden), "money"));
        }
        public static Label Status(string text)
        { var label = Text(text, "status"); return label; }
        public static VisualElement State(string title, string detail)
        { var panel = Panel(title); panel.Add(Text(detail, "body")); return panel; }
        public static VisualElement Goal(GoalView goal, bool hidden)
        {
            var panel = Panel(goal.Title, "META FINANCEIRA"); panel.Add(Status(goal.State));
            panel.Add(Text("Progresso realizado", "caption"));
            Value(panel, "Objetivo", goal.Target, hidden);
            Value(panel, FinancialLabels.Title(FinancialMeaning.GoalFunding), goal.Credited, hidden);
            Value(panel, "Restante · calculado pelo servidor", goal.Remaining, hidden);
            // The wire contract has exact amounts, no percentage. Never invent a local progress ratio.
            return panel;
        }
        public static VisualElement Sheet(string title, string detail, Action close)
        {
            var scrim = new VisualElement(); scrim.AddToClassList("scrim");
            var sheet = State(title, detail); sheet.AddToClassList("sheet");
            sheet.Add(Action("Fechar", close)); scrim.Add(sheet); return scrim;
        }
    }
}
