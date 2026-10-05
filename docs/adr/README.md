# Architecture Decision Records

Create `NNNN-short-title.md` for a consequential decision or change to an established boundary, dependency, security policy or operational strategy. Routine implementation details belong in the PR specification.

Use [the template](template.md). Status is Proposed, Accepted, Rejected or Superseded; mark acceptance only with review/authorization evidence. Numbers are monotonic. Supersession links both records; do not erase decision history.

Canonical documents own the current rules. ADRs record context, alternatives and consequences, and link to the owning section instead of copying the full policy. Update ADR status and canonical rules together. A proposed ADR cannot silently override an accepted rule.

Index:

- [0001: foundation ownership](0001-foundation.md) — Accepted; user-approved constraints and architecture selected within the PR-00 task; downstream review is still required.
- [0002 — Meaning-based data classification](0002-data-classification.md) — Accepted for architecture; implementation evidence pending.
- [0003 — Versioned authenticated user envelopes](0003-authenticated-envelopes.md) — Accepted for architecture; implementation evidence pending.
- [0004 — Unique user DEKs and explicit lifecycle](0004-per-user-key-lifecycle.md) — Accepted for architecture; implementation evidence pending.
- [0005 — External key protection and lifecycle custody](0005-key-provider-and-control-store.md) — Accepted for architecture; implementation evidence pending.
- [0006 — Encrypted deterministic financial projections](0006-encrypted-financial-projections.md) — Accepted for architecture; implementation evidence pending.
- [0007 — Minimized advisory AI context](0007-ai-privacy-boundary.md) — Accepted for architecture; implementation evidence pending.
- [0008 — Safe event-only observability](0008-safe-observability.md) — Accepted for architecture; implementation evidence pending.

PR-00.SEC decisions resolve the security questions deferred by ADR 0001; PR-00 scope/history remain unchanged. Acceptance here records delegated design choices, not external audit or deployment approval.

- [0009: repository and development foundation](0009-repository-development-foundation.md) — Accepted; automated/manual evidence in PR-01.

- [0010: Supported Unity Editor](0010-unity-supported-editor.md) — Accepted through developer adoption; supersedes the LTS-only choice in 0009.

- [0011: persistence and independent development custody](0011-persistence-crypto-development-adapters.md) — Accepted within PR-02 delegated scope; production adapter gates remain open.

- [0012: OIDC and independent opaque sessions](0012-oidc-independent-sessions.md) — Accepted within PR-03 delegated scope; real provider/custody deployment gates remain open.

- [0013: exact ledger and atomic realization](0013-financial-ledger-and-atomic-realization.md) — Accepted within PR-04.A delegated scope; production/maintenance gates remain open.

- [0014: Work revisions and declared capacity](0014-work-revisions-and-declared-capacity.md) — Accepted within PR-05.A delegated scope; production gates unchanged.
