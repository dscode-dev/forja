# 0008 — Safe event-only observability

- Status: Accepted
- Verification: architecture/specification only; implementation evidence pending
- Date: 2026-10-04
- Scope: [PR-00.SEC](../prs/PR-00.SEC.md)
- Canonical owner: [current contract](../security.md#safe-observability-and-temporary-processing)
- Decision authority: user delegated these security choices in the PR-00.SEC request; design review is documented in its validation record, not an independent security audit.
- Supersedes/superseded by: none

## Context and alternatives
Generic request/error/SQL/provider instrumentation can bypass persistence encryption and leak financial values.

## Decision
Use typed allowlisted operational events and disable payload capture across all sinks; apply the canonical canary verification gates.

## Consequences and validation
Less payload debugging is deliberate. Safe error/correlation codes support investigation; redaction alone is insufficient.
