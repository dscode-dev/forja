# Engineering principles and Definition of Done

## Working rules

Production software from day one. Product mocks, fake production data, placeholder architecture, demo-only implementations and TODO-driven incomplete features are forbidden. Test fixtures are permitted only inside tests. Do not seed fictitious users, balances or histories into runtime environments.

Keep changes bounded to the authorized PR. Prefer concrete implementations and explicit module contracts; avoid unnecessary abstractions. Stack/runtime ownership is canonical in [architecture](architecture.md). Implement no future feature to make a current demo appear complete.

Before code, resolve the current PR's prerequisite decisions and acceptance criteria. Pin dependencies and tool versions; document reproducible macOS/Docker workflows as they are established. Keep credentials out of source and artifacts. Schema changes need reviewed forward migration and recovery procedures; do not treat destructive rollback as a default.

Validate untrusted inputs at application boundaries. Enforce authorization in server use cases, not only routing/UI. Define errors, timeout/retry behavior and idempotency for mutations. Observability must satisfy [security](security.md). Add dependency/service complexity only with evidence.

Use tests proportional to risk: deterministic financial arithmetic, posting/settlement/retry correctness, authorization/isolation and progression evidence require meaningful automated tests. Verify Unity/API compatibility and device behavior for relevant changes. Do not write tests merely mirroring implementation or testing prose.

## Definition of Done

A PR is complete only when all applicable items have evidence:

1. Authorized outcome and bounded acceptance criteria are met; no partial feature, placeholder or pending TODO is required for correctness.
2. Required decisions are resolved; canonical docs and ADRs reflect changed ownership/rules without duplication.
3. Financial, game, AI and security invariants relevant to the change hold, including failure/retry paths.
4. Appropriate tests, build, static checks and migration/contract validation pass. Record exact commands/results; explain checks genuinely inapplicable to documentation changes.
5. Sensitive-data paths, authorization, telemetry, persistence and provider exposure meet the approved security contract; no production-sensitive feature bypasses PR-00.SEC.
6. Deployment/configuration, compatibility and recovery implications are reviewable when applicable; assets have provenance and rights evidence.
7. Review finds no unresolved blocker within the claimed scope; deferred work has explicit scope/dependency and is not required for this PR to function.

For documentation-only PRs: check links, decision ownership, consistency, unresolved gates and absence of unintended implementation. Builds and runtime tests are inapplicable until code exists.
