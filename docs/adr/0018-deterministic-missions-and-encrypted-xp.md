# ADR 0018 — Deterministic missions and encrypted XP

Status: accepted for PR-08 local implementation, 2026-10-06; physical/production gates separate.

The explicit PR-08 request establishes the first mission definitions, curve and correction policy. Existing deterministic evidence supports dedicated-goal realized funding and confirmed Work profiles; it does not support household expense-baseline reserve months, spending/habit streaks or inferred career success.

Choose the three templates, one-source repeatability, 30-day UTC window, fixed virtual awards and linear curve in [Game rule 1](../domains/game.md#mission-rule-1). Reserve designation is explicit user intent on a goal, not an inference from savings. No money-dependent XP multiplier or hardship penalty. Corrections retain historical XP while appending changed-basis evidence; initial eligibility requires below-target resources, and a source is never rewarded twice.

Use explicit per-instance evaluation with PostgreSQL's existing owner guard, shared with financial/profile changes. Completion, immutable mission revision, unique award and progression pointer commit together. SQL owner/source and owner/award uniqueness supplement lifecycle/authorization guards. No Redis, background scan, microservice, new crypto or financial writes. Purpose-specific owner read contracts extend existing services without changing their wire APIs. Goal evaluation uses the real Finance snapshot; Work and empty progression require no fabricated financial stream.

All personalized game/XP/evidence/status is encrypted with existing EncryptedRecord and admitted key scopes. Head replay/orphans/award sequence gaps fail closed; full valid suffix rollback retains the documented residual risk and recovery gate. Plaintext indexes expose only classified opaque selectors/counts/times. Erasure deletes Game before dependent source domains/wraps. Unity displays server values and submits source/evaluation/cancellation intents, without predicting awards, persisted game caches or extra primary navigation.

Canonical persistence/AAD: [persistence](../persistence.md#game-persistence); API/application boundaries: [Game contract](../contracts/game.md). Evidence: [PR-08](../prs/PR-08.md). Future rule/curve versions must preserve historical resolvers and evidence, rather than silently changing version 1.
