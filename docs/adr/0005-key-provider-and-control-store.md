# 0005 — External key protection and lifecycle custody

- Status: Accepted
- Verification: architecture/specification only; implementation evidence pending
- Date: 2026-10-04
- Scope: [PR-00.SEC](../prs/PR-00.SEC.md)
- Canonical owner: [current contract](../security.md#key-hierarchy-and-custody)
- Decision authority: user delegated these security choices in the PR-00.SEC request; design review is documented in its validation record, not an independent security audit.
- Supersedes/superseded by: none

## Context and alternatives
Financial DB rollback or write compromise must not reset nonce allocation or undo deletion/revocation. Vendor-specific KMS calls must not enter domain code.

## Decision
Use the two linked infrastructure contracts: managed key protection and independently permissioned strongly consistent lifecycle controls. Separate development keys/providers.

## Consequences and validation
This adds a justified control-plane dependency, not a business service or Redis. It fails closed on outage; PR-01/02 select and verify compliant adapters without inventing policy.
