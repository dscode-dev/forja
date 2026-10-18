# Estrategista v1

[AI rule](../domains/ai.md#estrategista-rule-1-pr-09b) owns facts/grounding/retention; [Game](game.md) owns template eligibility, completion and rewards. Existing authenticated owner/session, strict JSON and no-store apply. No prompts/provider payloads or owner inputs. No financial mutation endpoint.

| Route /v1/ai/estrategista | Input | Outcome |
| --- | --- | --- |
| GET / | Query focus=GENERAL|GOAL|RESERVE, goalId=owned UUID or empty for GENERAL | Current cached strategy/status; never inference |
| POST / | {intent:{goalId:UUID|null,focus},requestKey:UUIDv4,retryOf:execution UUID|null} | Explicit shared-limited inference/reuse; changed sources get a new subject |
| GET /proposals | Same query as GET | state, executionId, valid undisposed proposal or null |
| POST /:executionId/accept | {} | Authoritative Game mission DTO; at most one assignment, no completion/XP |
| POST /:executionId/dismiss | {} | {action:DISMISSED,missionId:null}; cannot undo an accepted assignment |

GENERAL requires null/empty goalId; GOAL/RESERVE require an owned exclusively funded goal. Intent names/titles/amounts are not accepted. Acceptance uses execution identity as its server-selected Game command key; clients cannot supply template/target/reward/completion fields. Conflict/stale/disabled adoption returns sanitized 409; foreign/missing private IDs deny access without payload. Default retry semantics follow [AI](ai.md); a changed subject is a new intent, not replay of an old failed request. No automatic write retry/polling.

Strategy: state, executionId|null, strategyId|null, promptVersion, createdAt|null, failure|null, cached, narrative|null, evidence|null, proposal|null, decision|null (and model when an execution binding exists). Shared AI states plus NO_ACTION and STALE. No-action/insufficient data sends no context and fabricates no narrative. cached means prior execution identified, not provider success. A changed source never silently reuses its commentary for adoption.

Narrative is only for SUCCEEDED: {schema:1,kind:AI_STRATEGY,method:MODEL_SELECTED_REVIEWED_TEXT,summary:Line,focus:Line,proposal:selection|null,limitations:string[]}; Line={text,metricRefs}. Model selects reviewed findings/template/version/rationale only. Proposal is separately enriched by Game: template,version,title,description,rewardXp,goalId,rationale. No model-supplied XP/parameters. Decision is encrypted server evidence {action:ACCEPTED|DISMISSED,missionId:UUID|null}; replayed acceptance returns that original Game mission even if later sources changed. Current retrieval may show STALE plus the prior accepted decision, with no newly actionable proposal.

Evidence is deterministic, separately labeled current focus consultation: scope USER_SELECTED_FOCUS, server UTC day, currency|null, settledMinor|null, accountMovementMinor|null, goalTargetMinor|null, goalRemainingMinor|null, pendingOutgoingMinor|null, pendingIncomingMinor|null, expenseBaseline=null,coverageDays=null,idealReserveTarget=null. Minor strings are formatted/masked by the client, never calculated by AI. These exact values are never in provider context. Account movement is last seven complete UTC days, not historical proof of reserve allocation. Work comparison refers only to an authenticated stored calculation and its own horizon; no weekly-versus-lifetime income target is invented.

Legacy shared execution persistence/status uses report_id/report_generation (wire reportId) as its technical source binding. Estrategista routes expose strategyId; no report_requests/report_snapshots row is fabricated. Its source kind is fixed by authenticated config_version. Source-validation trigger enforces same-owner real Chronicle or strategy-subject existence at admission; routing is immutable afterward. Existing Alquimista wire/AAD remain compatible.
