# AI v1 — Alquimista

[Canonical AI rules](../domains/ai.md#alquimista-rule-1-pr-09a) own consent, grounding, limits and lifecycle. All routes require the existing authenticated owner/session and return Cache-Control: no-store. Strict request objects reject unknown fields; no owner parameter. Errors use existing sanitized platform codes. No provider response, prompt, usage/billing or source context is returned.

| Method /v1/ai/... | Request | Response |
| --- | --- | --- |
| GET preferences | No query | enabled:boolean, revision:integer, policyVersion:string, providerAvailable:boolean, disclosure:string |
| PUT preferences | {revision,enabled,policyVersion} | Same; revision CAS, explicit grant/revoke; conflict requires re-read |
| GET alquimista/:reportId | No query | Analysis below; retrieval never dispatches inference |
| POST alquimista/:reportId | {requestKey:UUIDv4,retryOf:UUID or null} | Analysis; retryOf can dispatch only a retry of current FAILED execution, under limits; an active/successful binding is reused |
| GET executions/:id | No query | That exact owned execution's analysis/status; absent/foreign ID 404 |
| DELETE executions/:id | No query | 204; deletes commentary early, preserves minimal command receipts/quota |

Analysis: {state,executionId:UUID|null,reportId:UUID,promptVersion:1,model,createdAt:ISO|null,failure:enum|null,narrative:object|null,cached:boolean}. model is a technical configuration reference, never a factual authority. cached indicates an existing attempt was identified; it does not imply success. Source removal/expiry makes report routes 404; exact existing execution status may return EXPIRED. Disabled preference hides retained commentary. Old consent generations are CANCELLED on status reads. Source Chronicle versions have different opaque identities; no stale cross-version reuse.

States: DISABLED, UNAVAILABLE, ABSENT, INSUFFICIENT_CONTEXT, THROTTLED; persisted RUNNING, SUCCEEDED, FAILED, CANCELLED; synthetic EXPIRED for a removed result/source. Failure classifications: CONFIGURATION, TIMEOUT, UNAVAILABLE, RATE_LIMIT, REFUSAL, INVALID_OUTPUT, OUTCOME_UNKNOWN, CONSENT_REVOKED, SOURCE_EXPIRED, INSUFFICIENT_CONTEXT, THROTTLED, CANCELLED. HTTP success with typed unavailable is not a successful model response. Unknown delivery after timeout/crash must never automatically retry.

Only SUCCEEDED has narrative: {schema:1,kind:AI_INTERPRETATION,method:MODEL_SELECTED_REVIEWED_TEXT,summary:Line,highlights:Line[],attentionPoints:Line[],observations:Line[],questions:string[],limitations:string[]}. Line={text:string,metricRefs:string[]}; refs are fixed catalogue-owned Reporting metric paths, not entity identifiers. Text is reviewed inert Portuguese, never arbitrary model HTML/Markdown. Frontend does not calculate facts from references. UI distinguishes this commentary from deterministic metrics and masks its inferred financial content with the existing value-visibility control.

The provider-only structured selection contract and finding/phrase catalogue live in apps/api/src/ai/model.ts; neither raw selections nor backend-only exact Reporting facts are the mobile wire contract. OpenAPI/code generation is not introduced by this PR.
