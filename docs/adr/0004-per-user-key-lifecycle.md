# 0004 — Unique user DEKs and explicit lifecycle

- Status: Accepted
- Verification: architecture/specification only; implementation evidence pending
- Date: 2026-10-04
- Scope: [PR-00.SEC](../prs/PR-00.SEC.md)
- Canonical owner: [current contract](../security.md#lifecycle-rotation-and-recovery)
- Decision authority: user delegated these security choices in the PR-00.SEC request; design review is documented in its validation record, not an independent security audit.
- Supersedes/superseded by: none

## Context and alternatives
One shared data key would expose every user on DEK theft; key rotation, revocation and retained backups require different states.

## Decision
Use independent user DEK versions, admitted/fenced operations, request-only plaintext keys, dual-read/single-write migration and the canonical backup/deletion policy.

## Consequences and validation
A shared KEK/workload compromise still has broad reach. Old backups delay irreversible deletion; no immediate crypto-shredding claim. Verify migration/restore dependencies.
