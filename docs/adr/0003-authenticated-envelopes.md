# 0003 — Versioned authenticated user envelopes

- Status: Accepted
- Verification: architecture/specification only; implementation evidence pending
- Date: 2026-10-04
- Scope: [PR-00.SEC](../prs/PR-00.SEC.md)
- Canonical owner: [current contract](../security.md#user-payload-envelope-and-aad)
- Decision authority: user delegated these security choices in the PR-00.SEC request; design review is documented in its validation record, not an independent security audit.
- Supersedes/superseded by: none

## Context and alternatives
Stored financial records need confidentiality and rejection of ciphertext transplantation without invented cryptographic primitives.

## Decision
Approve the linked AES-256-GCM/envelope/AAD contract and independently allocated nonce sequence. Do not substitute random fallback, shortened tags or deterministic amount encryption.

## Consequences and validation
Strict parsing, authenticated metadata and durable allocation add implementation obligations. AEAD does not prove record freshness; external checkpoints address bounded replay risk.
