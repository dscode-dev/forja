# ADR 0019 — Bounded deterministic reports and immutable Chronicles

Status: Accepted for explicitly authorized PR-10.A local implementation.

Decision: [Reporting rule 1](../domains/reporting.md) owns periods, comparisons, account scope, source observations and immutable snapshot semantics. Compose existing encrypted Finance projections/buckets with boundary events, rejecting oversized selections instead of implementing an unproven worker or decrypting lifetime history. Reuse shared PostgreSQL owner guard/envelope/erasure; add purpose-specific reads in each owner, no foreign repositories. Work/Identity observations occur before the guard, immutable version references stay frozen.

Seven-day regenerable-artifact retention follows existing security policy. Separately encrypted minimal command receipts follow existing account command-audit retention, allowing safe replay rejection after snapshot expiry without retaining report metrics. No retention-policy extension, new crypto design, AI or financial mutation. User-facing versions are owner generation sequences, not mutable reports.

Consequences: historical corrections produce new observations; old snapshots remain explainable while retained. Old reports with more than 1,000 bounded inputs/tail buckets fail explicitly; future maintenance checkpoints need separate scope/evidence. Production requires verified expiry-sweep scheduling/lag/capacity, existing managed custody/recovery gates and authenticated physical acceptance. No new full-database tamper prevention claim.
