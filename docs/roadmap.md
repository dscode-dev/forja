# PR roadmap and decision gates

The user supplied this approved baseline after confirming that the empty workspace is intentional. Preserve its product scope and PR identities. Entries define dependency order, not implementation authorization.

| PR | Bounded outcome | Hard prerequisites |
| --- | --- | --- |
| PR-00 | Product Constitution & Technical Architecture | Repository inspection |
| PR-00.SEC | Security, Privacy & Cryptographic Architecture — policy finalized; implementation verification remains downstream | PR-00 |
| PR-01 | Repository & Development Environment: pinned tools, Docker workflows, Unity project/build setup and CI | Completed/approved PR-00.SEC |
| PR-02 | Backend Foundation & Persistence: module infrastructure, migrations and approved persistence/security adapters | PR-01; PR-00.SEC verification contract |
| PR-03 | Identity, Authentication & User Profile: authorization, sessions, user isolation and approved key lifecycle integration | PR-02 |
| PR-04 | Financial Ledger & Auditability | PR-03; Finance posting/currency/source decisions |
| PR-05 | Financial Goals, Capacity & Work Profile | PR-04; approved Planning formulas and Work inputs |
| PR-06 | Unity Mobile Foundation & API Integration: session, secure storage and real API contracts | PR-03; PR-04/05 for financial capabilities integrated here |
| PR-07 | Anime World, Characters & Game UI | PR-06; reviewed art/device/presentation decisions |
| PR-08 | Missions & Progression Engine | PR-04/05; PR-07 for client presentation; approved evidence/reward rules |
| PR-09 | AI Agents & Orchestration: Alquimista, Estrategista, Oráculo | PR-05/08; PR-10.A; PR-00.SEC AI policy; provider/context/output/evaluation decisions |
| PR-10 | Chronicles, Reports & Integrated Mobile Experience | Split as below to remove reporting/AI dependency cycle |
| PR-11 | Production Hardening & Release Readiness | All launch-scope PRs; production hosting/distribution/privacy decisions |

## Dependency refinements and splits

- PR-00.SEC is completed before **every implementation PR**. Its choices affect persistence, authentication, secure storage, logging, backups, AI and Finance; no tooling/bootstrap implementation exception is authorized.
- PR-04.A implements actual ledger/audit **and basic Planning expectations/atomic full settlement**, explicitly required by the attached PR-04.A request. This anticipates the former PR-04.B basic scope without changing module ownership. PR-04.B now holds separately specified expected-item revision, partial realization and source reconciliation refinements; PR-05 can consume the basic PR-04.A contracts without waiting for optional refinements. See [ADR 0013](adr/0013-financial-ledger-and-atomic-realization.md).
- PR-05.A implements Work/profile inputs and declared capacity; PR-05.B implements Planning/goals/required-income on those reads; both child specifications retain their production gates. Planning capacity depends on confirmed Work inputs and PR-04.A basic expectations (PR-04.B only when using its refinements). This avoids one oversized PR across two bounded modules.
- PR-06 builds the mobile application boundary on the PR-01 Unity tooling/project base. It uses real contracts as they become available; later product integrations depend on their owning backend PRs. No synthetic product responses are approved.
- Split PR-10 into PR-10.A deterministic reporting contracts/period rules and PR-10.B Chronicles and integrated mobile experience. PR-10.A depends on PR-04/05 and precedes PR-09 because Alquimista needs deterministic reports. PR-10.B depends on PR-06/07/08/09 and PR-10.A. This changes dependency order only, not product scope.
- PR-08 server rules can be specified independently of art, but its completed mobile experience requires PR-07. PR-09 remains downstream of deterministic Finance/Planning/Reporting and validated Game contracts.
- Production checks apply in every PR; PR-11 exercises the integrated release rather than deferring correctness/security until launch.

PR-00.SEC has finalized the prior policy blockers without authorizing implementation. PR-01 prepares secret separation/configuration only; the explicitly authorized PR-01 scope defers actual key/lifecycle setup and adapter/rotation/recovery verification to PR-02, because no sensitive persistence exists yet; PR-03 verifies identity-to-key authorization; PR-04 verifies encrypted atomic projections. These are security infrastructure/acceptance refinements, not product scope changes.

Write bounded child specifications before implementation. Preserve parent outcomes and prerequisites; record any further scope/architecture change with its reason and decision evidence.

## Unresolved decisions and owning gate

| Decision group | Owner / first blocking gate |
| --- | --- |
| Security policy | Finalized in [PR-00.SEC](prs/PR-00.SEC.md); downstream PRs must meet its verification contract |
| Compliant managed KMS, independent lifecycle store, environment isolation and native adapters | Production custody selection/integration before staging/production S2/S3 use; PR-02 deliberately does not select a vendor; [security](security.md) fixes policy |
| Repository/tool versions and development migration workflow | Established by PR-01 in [development](development.md) |
| Domain API/payload schemas and hosted CI attachment | Entity-owning PRs/repository hosting; platform persistence conventions established in [persistence](persistence.md); preserve PR-01 validation entrypoint |
| Authentication provider enrollment and production session custody | Protocol/session/profile/isolation established in [Identity](identity.md); real issuer/callback and independent production adapters before deployment |
| Currency/posting/basic expectations established; reconciliation and financial formulas | PR-04.B/05/10.A; [financial domain](domains/financial.md) |
| Career inputs/goals/required-income established in PR-05.A/B; progression/mission policy and visual pipeline | PR-08/07; relevant [domain](domains/game.md)/[art](art-direction.md) owner |
| AI provider, context/output rules and evaluations | PR-09; [AI domain](domains/ai.md), constrained by PR-00.SEC |
| Audience, launch scope, jurisdiction, revenue and notifications | [product](product.md); resolve before dependent feature/release PRs |
| Hosting, mobile distribution and operating responsibilities | Release planning, before production deployment |

Resolve scoped blockers rather than inventing defaults. Detailed choices belong in the owning canonical document after an accepted decision.

PR-02 implementation evidence is in [its specification](prs/PR-02.md). Development custody/transactions/envelopes permit PR-03 local implementation. Managed production key/control adapters and restore/drain verification remain open gates before any staging/production S2/S3 use; do not interpret local READY as production security approval. PR-03 implements Identity FK/binding/session/profile enforcement; PR-04.A implements encrypted financial inventory/basic realization and local checkpoint anchoring; operational retention/backup drills remain required before deployment. No product scope or stack decision changed.

PR-06 implementation/evidence: [specification](prs/PR-06.md). Device HTTPS connectivity and real OIDC login are separate prerequisites for its integration acceptance; PR-07 must not assume those gates passed from a native build.

PR-07 scoped presentation may proceed under the explicit user request while PR-06 hosted HTTPS/OIDC integration remains blocked. This refines implementation order only: real authenticated acceptance and production security gates remain prerequisites for dependent integrated acceptance. The approved 2D direction/pipeline belongs to [art](art-direction.md), executed presentation evidence to [PR-07](prs/PR-07.md).
