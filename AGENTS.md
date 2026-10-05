# Forja — agent entrypoint

Read this file, the canonical document for the affected domain, and the current PR specification before editing. Follow their links only when crossing a boundary. No implementation is authorized by documentation alone.

- Product scope: [constitution](docs/product.md).
- Module ownership, dependencies, Unity layers: [architecture](docs/architecture.md).
- Authentication, sessions, ownership and minimal profile: [identity](docs/identity.md).
- Money, obligations, forecasts, audit: [financial domain](docs/domains/financial.md).
- Work inputs, historical profiles and declared capacity: [Work](docs/domains/work.md).
- Missions, rewards, character progression: [game domain](docs/domains/game.md).
- AI characters, context and authority: [AI domain](docs/domains/ai.md).
- Visual assets and financial readability: [art direction](docs/art-direction.md).
- Sensitive-data handling and security gate: [security](docs/security.md).
- Implementation rules and Definition of Done: [engineering](docs/engineering.md).
- PR order, gates and unresolved decisions: [roadmap](docs/roadmap.md).
- Decision process: [ADRs](docs/adr/README.md).

Current work: [PR-05.A](docs/prs/PR-05.A.md); persistence/crypto implementation: [persistence](docs/persistence.md); commands/version ownership: [development](docs/development.md). Next scope follows the [roadmap](docs/roadmap.md). Local acceptance does not imply production verification.

Before implementing any later PR, write its bounded specification: outcome, canonical references, prerequisites, owned changes, exclusions, acceptance evidence and unresolved decisions. Do not infer authorization from a roadmap entry.

Use the approved stack and canonical boundaries. Read the security sections referenced by the current PR before crypto, persistence, identity, telemetry, mobile storage or AI work; satisfy its implementation gates. Stop dependent work when a required decision is unresolved; continue independent authorized documentation work. Record lasting decisions through ADRs and update the owning canonical document in the same change. Never duplicate rules in PR specs; link them. No commits, publication or external messages without user authorization.

Mobile validation: agents work primarily through VS Code; Unity Hub/Editor run locally on macOS. The authoritative runtime device is the physical **iPhone 15 Pro Max**; simulators/emulators are not substitutes. For required manual Unity/iOS checks, return **MANUAL MOBILE VALIDATION REQUIRED** with the eight steps/evidence requirements in [mobile workflow](docs/mobile-development.md). Never mark unexecuted Editor/device tests PASS; await developer results.
