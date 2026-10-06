# Planning goals v1

Domain/formulas/classification: [Planning](../domains/planning.md); auth: [Identity](identity.md). All routes require existing Forja bearer auth, verified-owner filtering and no-store. No owner/key/ciphertext/balance assignment. Unknown properties rejected; money is canonical minor-unit strings.

| Route | Strict input / output |
| --- | --- |
| POST /v1/planning/goals | `{idempotencyKey,goal}` → original goal revision DTO |
| GET /v1/planning/goals | optional `after` UUID, `limit` 1–100 → `{goals,next}` |
| GET /v1/planning/goals/:id | optional positive `revision` → `{id,revision,createdAt,recordedAt,status,goal,completion}` |
| PUT /v1/planning/goals/:id | `{idempotencyKey,expectedRevision,goal}` → revision DTO |
| POST /v1/planning/goals/:id/state | `{idempotencyKey,expectedRevision,action}`; pause/resume/complete/cancel → revision DTO |
| GET /v1/planning/goals/:id/progress | current settled funding/deficit, goal/Finance versions and account state; never includes projected money as progress |
| POST /v1/planning/goals/:id/calculations | `{idempotencyKey,expectedRevision,workRevision,projectCount}`; last two explicit null or bounded integers → saved reproducible calculation DTO |
| GET /v1/planning/goals/:id/required-income | latest saved generation; 404 until generated; does not recalculate or write on GET |
| GET /v1/planning/goals/:id/calculations/:calculationId | exact saved generation; source configuration/Finance/Work may have changed since generation |

goal: `{title,description,targetMinor,currency,startDate,deadline,fundingAccountId,retainedEarningsBasisPoints}`. Title ≤120; description null or ≤500; NFC/trimmed/nonempty/control-free with bounds after normalization. Dates YYYY-MM-DD, start≤deadline. Basis points integer 0–10000. No starting amount/default retention. UUIDs canonical; idempotency requires UUIDv4. Revisions positive int32; workRevision null means latest optional Work profile, not a fabricated default; explicit missing revision is 404. projectCount null or 0–1000, only with a project component. Numeric queries are canonical decimal integers.

Calculation returns ID/generation/recordedAt/formula, goal/Work/Identity/Finance references, timezone/frozen calculationDate/from/through/days/workdays/minutes/month exposure, fixed-monthly declaration if applicable, CONSERVATIVE and PLANNED category totals/goal deficit/funding shortfall/retained and gross requirements/rates/comparison and explicit assumptions/reasons. Gross requirements use declared retention. No raw persisted entities, private professional/identity/goal text or current-state freshness promise for saved calculations.

Errors follow safe platform mapping: invalid/mismatched currencies 400, unauthenticated 401, missing 404, stale revision/occupied funding account/invalid transition/closed calculation basis 409, dependency/integrity 503, excessive expectations 422 BOUNDED_PERIOD_REQUIRED. Same-key replay returns its original immutable version even after later changes; reused key for different intent conflicts. Generate with a new key for fresh sources/time. No financial command or LLM side effect.
