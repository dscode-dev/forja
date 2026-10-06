# ADR 0017 — 2D atelier and memory-only RPG presentation

Status: accepted for PR-07 implementation, 2026-10-06; device/distribution acceptance separate.

Context: PR-07 needs a real anime personal-RPG shell while HTTPS/OIDC enrollment remains unavailable. The developer explicitly approved 2D anime, an urban atelier and equal adult male/female character directions. No persisted avatar or progression contract exists.

Decision: use a static 2D illustrated atelier and interchangeable transparent character catalogue with UI Toolkit. PresentationArt owns catalogue textures/expression/optional bounded idle frames, independent of business UI. Static neutral idle ships in the local validation build; no skeletal rig, inferred financial mood, invented XP, equipment system or asset streaming. Four primary destinations and contextual Accounts/Work use the existing coordinator and unchanged wire contracts. Snapshot fields become typed presentation values rather than concatenated strings. Current goal transport supplies amounts, so progress is an exact amount breakdown, not a locally calculated percentage. Masks default on and private views disappear with coordinator memory invalidation. Native privacy remains intact.

Consequences: small texture/import budget, no 3D scene/physics costs, replaceable artwork without financial changes. Avatar choice is transient, explicit and reset with session loss; it creates no authoritative user property. Reports/progression show honest unavailable surfaces until their owning PRs. Catalogue can be inspected publicly without fake authentication. Device quality/performance and authenticated use remain required acceptance gates.

Canonical behavior/budgets/provenance: [art](../art-direction.md), [mobile workflow](../mobile-development.md), [asset record](../assets/PR-07-art.md). Executed checks: [PR-07](../prs/PR-07.md).
