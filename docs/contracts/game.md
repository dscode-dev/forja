# Game v1 wire and application contracts

Rules/classification: [Game](../domains/game.md). Authentication, error bodies and no-store: [Identity](identity.md). No owner, balance, XP, completion, encrypted state or free-form rule input. All routes require an existing Forja bearer session and verified owner. Strict body/query properties, existing 8-KiB body limit.

| Route | Input / response |
| --- | --- |
| GET /v1/game/candidates | optional owned goalId; `{candidates:[{template,goalId,goalRevision}]}`; Work plus two alternatives for that one eligible goal, excluding already assigned sources |
| POST /v1/game/missions | `{idempotencyKey,template,goalId,goalRevision}`; UUIDv4 is assignment/instance command identity; goalId/revision explicit null for WORK_PROFILE; returns existing/new mission DTO |
| GET /v1/game/missions | after? UUID, limit? 1–100, view? active/history; `{missions,next,view}`. Pages select UUIDs before decrypting/filtering; an empty filtered page with next is not global absence |
| GET /v1/game/missions/:id | safe mission DTO |
| GET /v1/game/missions/:id/progress | same safe DTO, no evaluation/write |
| POST /v1/game/missions/:id/evaluate | `{}`; fresh deterministic evaluation, same DTO; natural mission/award idempotency, safe explicit retry after uncertainty |
| POST /v1/game/missions/:id/cancel | `{}`; terminal idempotent cancellation; completed missions retain their award |
| GET /v1/game/progression | `{curveVersion:1,xp,level,nextLevelXp,xpToNextLevel,recentEvent}`; recentEvent null or `{missionId,sequence,xp,recordedAt}` |

Mission DTO: id/revision/template/definitionVersion/category/title/description, assignedAt/recordedAt/expiresAt, state/completedAt/reconciliation, rewardXp/rewardState and progress. RewardState AWARDED only for COMPLETED; no separate claim API. Progress: settled-goal with currency/currentMinor nullable/targetMinor and null scalar current/target, or confirmed-profile with current 0/1,target 1 and null monetary fields. Current monetary value is unavailable when the financial basis differs from the frozen objective. No internal evidence, fingerprints, key references, personal goal title or Work contents. RecordedAt is the last stored Game record; explicit evaluation is required for new financial observations. Progression counts are exact safe JSON integers; money remains canonical minor strings.

400 invalid/unsupported schema, 401 authentication, foreign/missing IDs 404, stale/ineligible/conflicting assignment 409, integrity/custody/unknown commit 503. Assignment conflict/retry semantics belong to Game rule 1. Source uniqueness survives expiry, cancellation and corrections. A goal cannot earn both template alternatives.

Internal candidates/validateProposal are purpose-specific, authenticated reads. A future Estrategista receives only eligible source/template/revision proposals under its future consent/minimization gate; proposal validation assigns nothing and awards nothing. Actual assignment uses the same deterministic application command, never model instructions or provider facts. Game consumes GoalsService.missionFacts(Finance read unit,goalId) and WorkService.missionFacts(common owner-guarded transaction,principal); each owner authenticates/decrypts its own data in the existing transaction. No foreign table writes or nested owner-lock transactions.
