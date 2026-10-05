# 0006 — Encrypted deterministic financial projections

- Status: Accepted
- Verification: architecture/specification only; implementation evidence pending
- Date: 2026-10-04
- Scope: [PR-00.SEC](../prs/PR-00.SEC.md)
- Canonical owner: [current contract](../domains/financial.md#encrypted-financial-state-and-bounded-reads)
- Decision authority: user delegated these security choices in the PR-00.SEC request; design review is documented in its validation record, not an independent security audit.
- Supersedes/superseded by: none

## Context and alternatives
Plaintext SQL amounts defeat database-only confidentiality; decrypting all history on every request is unbounded.

## Decision
Use the canonical local ordered event stream, encrypted current state/buckets, atomic Finance posting and Planning settlement, bounded reads and ciphertext checkpoint anchoring.

## Consequences and validation
Exact formulas remain feature decisions. Jobs/rebuilds must authenticate provenance and report cursors. No generic event-sourcing framework, cross-user aggregation or searchable amount encryption is introduced.
