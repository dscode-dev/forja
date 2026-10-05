# 0014 — Work revisions and declared earning capacity

- Status: Accepted
- Date: 2026-10-04
- Authority: PR-05.A delegates compact modeling, earning semantics, formulas and history strategy; no cryptographic policy change.
- Canonical owner: [Work](../domains/work.md), [transport](../contracts/work.md), [persistence](../persistence.md).
- Supersedes: none.

Retain approved Work ownership while making its professional inputs consumable by Planning. Use a current revision pointer plus immutable encrypted full snapshots, optimistic replacement and server-effective timestamps. Mutable-only profiles would invalidate calculation provenance; heavyweight event sourcing and a separate generic history framework are unnecessary.

Derive capacity for an explicit bounded UTC civil-date horizon, with exact rational arithmetic and per-component rounding. Keep uncertainty explicit rather than invent project quantities, guaranteed income, net costs or four-week months. MIXED composes distinct declared components with at most one availability-based hourly/daily component, avoiding reuse of the same hours. Availability is weekly shape, not an employment calendar. Finance money validation is reused as a value-level import; no Finance service/module/persistence dependency is introduced.

Work snapshots authenticate approved metadata through existing user envelopes. No new independent Work freshness journal or security algorithm is selected. Partial replay fails against latest history; complete valid suffix rollback by a privileged writer remains a documented residual risk. Ordinary history immutability has the existing authorized privacy-erasure exception. Managed custody/reference inventory and historical-key maintenance remain deployment gates.
