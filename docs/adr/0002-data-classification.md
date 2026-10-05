# 0002 — Meaning-based data classification

- Status: Accepted
- Verification: architecture/specification only; implementation evidence pending
- Date: 2026-10-04
- Scope: [PR-00.SEC](../prs/PR-00.SEC.md)
- Canonical owner: [current contract](../security.md#classification-and-plaintext-allowlist)
- Decision authority: user delegated these security choices in the PR-00.SEC request; design review is documented in its validation record, not an independent security audit.
- Supersedes/superseded by: none

## Context and alternatives
Encrypting every column would break necessary owner/date/identity constraints; leaving derived financial fields queryable would expose the same secrets as transactions.

## Decision
Adopt the canonical field-family map and closed metadata exceptions. New fields fail closed to S3 until reviewed.

## Consequences and validation
Sensitive payloads and derived state require envelopes; approved metadata leaks remain explicit. Validate real schemas/dumps and no shadow amount/text columns.
