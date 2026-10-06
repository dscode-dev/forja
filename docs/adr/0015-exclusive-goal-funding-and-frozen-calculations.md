# 0015 — Exclusive goal funding and frozen calculation inputs

- Status: Accepted
- Date: 2026-10-05
- Authority: PR-05.B delegates funding, lifecycle, time/formula and reproducibility decisions.
- Canonical owner: [Planning](../domains/planning.md), [transport](../contracts/goals.md), [persistence](../persistence.md).
- Supersedes: none. No Finance/Work/Identity/crypto policy redesign.

Select an explicitly dedicated account with one reserved goal, rather than guessing which balances fund which goal or introducing partial transfers/contributions. Reservation is Planning attribution; Finance remains able to spend money. Completion requires an owner command backed by settled evidence; its private status/action remain encrypted because they can infer financial success. Cancellation explicitly releases attribution.

Select separate settled and conditional planned scenarios, exact Gregorian civil periods in Identity's timezone, user-confirmed gross retention and ceil-rounded required rates. Unknown denominators/Work estimates remain unknown. Existing Work capacity is reused within its 366-day bound; longer deadlines retain exact requirements with bounded-comparison limits, avoiding a Work redesign or fabricated extrapolation.

Freeze minimized encrypted calculation inputs and version refs instead of relying solely on historical cursors: pending item realizations/cancellations and timezone changes otherwise cannot reproduce old projections. Obtain pinned Work/Identity observations before Finance's common lock, then verify goal revision and compose current financial/Planning facts in one snapshot. Own Planning receipts give retry safety without posting to Finance or altering its stream. Consequences: extra immutable key/reference inventory and encrypted storage; no new independent goal freshness anchor or claim of complete database-write rollback prevention.
