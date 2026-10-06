# System architecture

## Runtime and stack

Modular monolith: one NestJS/TypeScript backend with explicit bounded modules and PostgreSQL persistence. Mobile is Unity/C# on Android and iOS; Flutter is excluded. Development uses macOS/MacBook and VS Code, primarily through LLM coding agents. Backend and dependencies run via Docker; Unity runs natively on macOS.

Redis requires a documented technical need; pgvector requires a documented semantic retrieval need. Neither is a baseline dependency. Extracting services requires evidence and an ADR; module count alone is not evidence.

## Backend ownership

| Module | Owns | Permitted dependencies |
| --- | --- | --- |
| Identity | User identity, authentication and authorization context | Platform capabilities |
| Finance | Accounts, authoritative balances, received income/completed debits, financial history, debts and settlements | Identity, platform capabilities |
| Planning | Scheduled debits, receivables, predicted income, reserve/goal plans, deterministic projections and required-income calculations | Identity, Finance public read contracts, Work read contracts |
| Work | [Work/career profile, availability, declared capacity and versioned user-confirmed assumptions](domains/work.md) | Identity; canonical Finance money value functions only |
| Game | Character state, missions, progression and virtual rewards | Identity, Finance/Planning/Work public read contracts or committed facts |
| Reporting | Period selection, deterministic financial summaries and report provenance | Identity, Finance/Planning/Work public read contracts |
| AI | Character advice, model context preparation and inference orchestration | Identity, approved minimized read contracts from Reporting/Planning/Work/Game |

Platform capabilities provide persistence, configuration, cryptographic services, observability and transport; they are infrastructure, not owners of financial or game rules. Their finalized [security contract](security.md) requires external KMS and independent lifecycle control capabilities; implementation evidence is gated by [PR-00.SEC](prs/PR-00.SEC.md).

Each module owns its writes and exposes application contracts. No foreign repository/table writes, shared mutable domain entities or circular module imports. Cross-module access passes authorization and returns purpose-specific data. Contracts are introduced for real consumers, not speculative extension points.

Planning requests settlements through Finance commands; Finance never depends on Planning. A settlement identity/result lets Planning reconcile its item idempotently. Finance exposes a local unit of work to Planning for atomic full realization; each owns its table writes. The [financial processing contract](domains/financial.md) defines atomic settlement and retry/recovery; the implementing PR specifies the concrete unit-of-work API.

Reporting owns no financial truth. Game and AI cannot invoke financial mutations. No module may bypass the [financial invariants](domains/financial.md). Direct database access from mobile is forbidden.

## Unity architecture

Use four logical responsibilities; these are boundaries, not instructions to scaffold assemblies or services now:

| Responsibility | Owns |
| --- | --- |
| Presentation | Scenes, character rendering/animation, RPG UI and readable financial views; no authoritative calculations |
| Application | Use-case flow, session lifecycle, navigation, command submission and synchronization |
| Domain | Pure C# local interaction/game presentation rules and typed values; no server-state authority |
| Infrastructure | API transport, serialization, approved local storage, OS secure-storage integration and asset loading |

Presentation invokes Application; Application uses local Domain and infrastructure contracts; Infrastructure implements those contracts. Scene objects do not own financial state. Keep Unity-specific rendering dependencies out of pure domain rules.

Backend contracts define persisted state and provenance. Local previews must be labeled and cannot become authoritative on synchronization. Offline financial writes are not approved; any later offline design requires conflict, retry and security decisions. Persisted progression follows the [game authority contract](domains/game.md); animation and transient feedback can be local.

PR-07 presentation uses the [2D art pipeline](art-direction.md#pr-07-presentation-pipeline) and [ADR 0017](adr/0017-2d-atelier-and-memory-only-presentation.md); no new backend module or financial authority.

The implemented native iOS composition, configuration and transport belong to the [mobile workflow](mobile-development.md#runtime-ownership-and-configuration); [PR-06](prs/PR-06.md) owns executed acceptance.

## Deferred implementation choices

Tool/version and development persistence choices are canonical in [development](development.md), established by PR-01 after PR-00.SEC approval. [Persistence](persistence.md) owns transaction/crypto adapter conventions; [Identity](identity.md) owns authentication/session behavior; [wire contracts](contracts/identity.md) own versioned mobile identity transport. Hosting, real OIDC provider enrollment, future domain API schemas, event delivery, asset pipeline and CI providers require scoped decisions. No technology selection here implies a cryptographic choice.
