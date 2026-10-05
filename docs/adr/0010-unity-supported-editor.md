# 0010 — Supported Unity Editor during early development

- Status: Accepted
- Date: 2026-10-04
- Scope: PR-01 mobile validation follow-up
- Canonical owner: [development](../development.md#pinned-tools), [mobile workflow](../mobile-development.md)
- Acceptance evidence: user questioned the LTS choice, agent recommended Supported for this new project, then developer opened the Supported Editor and returned compiler diagnostics. ProjectVersion and native package lock corroborate adoption.
- Supersedes: Editor LTS policy only in [0009](0009-repository-development-foundation.md); backend decisions remain unchanged.

## Decision and consequences

Use an exact Supported Update Editor pin during early development. Unity recommends Updates for new/mid-cycle projects; they receive production QA and support until replaced by the next release. LTS remains the alternative when locking a shipping baseline. Review upgrades as support changes; never float Editor/package versions. Current version/revision is owned by development.md and ProjectVersion.txt.

Retain the real Editor-generated package lock and module/settings normalization; its test-framework resolution replaces the initial authored pin. Static checks track this imported baseline. No product scope or security boundary changes. Compilation, EditMode and physical-device gates require fresh evidence; Editor opening alone does not pass them. Intel Editor support ends after 6.7 LTS, requiring a future workstation plan for Intel users.

Sources: [Unity release policy](https://unity.com/releases/unity-6/support), [Intel deprecation](https://discussions.unity.com/t/unity-to-deprecate-intel-based-mac-support-starting-with-unity-6-6/1721740).
