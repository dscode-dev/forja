using Forja.Core;

namespace Forja.Application
{
    public enum ShellDestination { Home, Goals, Reports, Profile, Accounts, Work }
    public sealed class ShellNavigation
    {
        public ShellDestination Destination { get; private set; }
        public bool HiddenValues { get; private set; } = true;
        public float TextScale { get; private set; } = 1;
        public bool ReducedMotion { get; private set; } = true;
        public string CharacterId { get; private set; }
        public void Go(ShellDestination destination) => Destination = destination;
        public void ToggleValues() => HiddenValues = !HiddenValues;
        public void ToggleTextScale() => TextScale = TextScale == 1 ? 1.2f : 1;
        public void SelectCharacter(string catalogueId)
        { if (catalogueId == "male" || catalogueId == "female") CharacterId = catalogueId; }
        public void SessionChanged(SessionState state, bool hasSnapshot)
        {
            if (state != SessionState.AUTHENTICATED || !hasSnapshot)
            { Destination = ShellDestination.Home; HiddenValues = true; CharacterId = null; }
        }
    }
}
