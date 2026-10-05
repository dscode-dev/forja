# 0007 — Minimized advisory AI context

- Status: Accepted
- Verification: architecture/specification only; implementation evidence pending
- Date: 2026-10-04
- Scope: [PR-00.SEC](../prs/PR-00.SEC.md)
- Canonical owner: [current contract](../domains/ai.md#context-pipeline-and-payload-schema)
- Decision authority: user delegated these security choices in the PR-00.SEC request; design review is documented in its validation record, not an independent security audit.
- Supersedes/superseded by: none

## Context and alternatives
Models need useful context while private histories, identity and exact amounts are unnecessary for baseline advice.

## Decision
Use the role-specific allowlist and deterministic/minimized pipeline, approved no-retention/no-training endpoints, no action tools and encrypted retained S3 results.

## Consequences and validation
Bands still reveal private traits; opt-in and provider review are mandatory. Exact results stay in deterministic UI. Endpoint incompatibility disables AI rather than weakening policy.
