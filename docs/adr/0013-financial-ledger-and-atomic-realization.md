# 0013 — Exact ledger and atomic expected-item realization

- Status: Accepted
- Date: 2026-10-04
- Authority: PR-04.A delegates money/posting conventions and explicitly requires expectations/settlement; policy remains PR-00.SEC.
- Canonical owner: [financial domain](../domains/financial.md); infrastructure: [persistence](../persistence.md); transport: [finance v1](../contracts/finance.md).
- Supersedes: none. Refines PR-04.A/B scope in [roadmap](../roadmap.md).

Select signed integer minor-unit strings and BigInt arithmetic, a small explicit ISO currency catalogue, immutable single-account effects and linked reversal/replacement. Account state and UTC contribution buckets are encrypted transactional projections; opening is an explicit user-confirmed fact. Decimal floating point, mutable settled entries, silent snapshot reconciliation and implicit FX are rejected.

The attached request requires basic expected commands now, so implement those inside Planning alongside the Finance unit of work. A common per-user PostgreSQL guard gives actual posting and expected realization one atomic commit without Finance depending on Planning. [PostgreSQL row-lock semantics](https://www.postgresql.org/docs/current/explicit-locking.html) supply cross-process serialization; separate unique constraints protect idempotency, settlement and reversal.

Anchor each committed encrypted checkpoint in the already independent development lifecycle journal. This realizes ADR 0006 without a new service or vendor. Journal outage leaves an opaque retry reference and safe alert after the financial commit. No claim of complete DB-write tamper prevention or production custody conformance follows. Immutable payload key migration/rebuild requires its separately authorized bounded maintenance specification before rotation/deployment; ordinary runtime cannot rewrite history.
