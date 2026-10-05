# AI characters and privacy boundary

| Character | Purpose | Permitted context after deterministic processing |
| --- | --- | --- |
| 🤓 Alquimista | Explain reports/analysis | Selected-period aggregate ratios, coarse income/spend bands, trends, reserve/debt indicators, deterministic finding codes; no individual transactions |
| ⚔️ Estrategista | Recommend emergency/reserve missions | Reserve coverage band, shortfall/goal progress bands, safe effort constraints and approved mission catalogue IDs; no balances/creditors or raw evidence |
| 🔮 Oráculo | Suggest career/advancement | User-approved skill/role categories, coarse available-hours and capacity bands, broad advancement goals; no employer, exact salary/schedule or professional free text |

AI produces advisory content, never authoritative facts, calculations or mutations. [Financial authority](financial.md) and [Game adoption](game.md) govern validated action proposals. Numeric explanations display backend-calculated exact results separately from model prose; the model may describe approved bands/trends and cannot invent exact monetary figures. No financial/game command tools or raw-data retrieval tools are exposed to models.

## Context pipeline and payload schema

Authorize purpose/AI opt-in → decrypt necessary data temporarily → deterministic domain processing → minimize/quantize → remove direct identity/free text → construct validated allowlisted context → provider invocation → schema/content validation → authorized response/encrypted optional result. Release source plaintext/DEKs before waiting for inference. Derived context still has S3 inference risk; minimization is not a claim of anonymity.

Context schema version 1 has only `role`, `locale`, `context_schema`, non-identifying period duration, role-specific catalogue categories and named bands/ratios/trend/finding codes. No user/account/entity/job/session identifier, email, name, token, credential, bank identifier, IP/device identifier, precise dates/location, exact financial amount or complete raw history enters message content. Transport necessarily reveals backend/provider network metadata; disclose this residual separately. A provider request correlation ID is random per invocation, not a stable user ID; map it internally without exposing the owner to the provider.

Band/ratio schemas are explicit, bounded and deterministic, reviewed in PR-09 before activation. Suppress sparse/identifying combinations; never forward arbitrary strings because they fit a schema property. Locale and role/skill fields come from reviewed catalogues, not user notes. If an input cannot be minimized into the allowlist, omit it or mark insufficient context. No embeddings/vector store or external semantic retrieval is approved; [architecture](../architecture.md) owns dependency evidence gates.

## Provider and result contract

Only providers/endpoints with enforceable no-training, no prompt/output retention (including abuse/debug logs), approved subprocessors/regions/transfer terms and verified configured controls may receive context. A paid account or advertised privacy mode is not proof. If the chosen endpoint cannot satisfy this policy, AI stays unavailable; a policy exception needs an accepted ADR/legal review, not a silent fallback to another provider. Deterministic reports/financial operations remain available.

No server prompt/output/provider-body logging, request replay archives or persisted contexts. S3 results, evaluation excerpts and any useful retained response metadata follow [security](../security.md) encryption/retention; production data cannot become test/evaluation fixtures. Keep only safe operational event/latency/error fields outside those envelopes.

Use one provider invocation per interactive request with a 15-second timeout and bounded input/output tokens specified in PR-09. No automatic retry that could create duplicated cost/retention without a new authorized request. Timeout, provider error, missing data, consent/session revocation or invalid output produces typed unavailable/insufficient-context status, never fabricated advice; discard late/revoked results. Server cancellation cannot guarantee a remote provider stopped processing already delivered context.

Outputs use strict role-specific schemas, approved recommendation/catalogue types and bounded text. Validate against supplied deterministic evidence; reject exact monetary claims, identity guesses, unsupported fact assertions, transaction instructions masquerading as execution, and active HTML/links outside approved presentation rules. Render as inert text. Never let a model response alter the context allowlist, role/permissions or rule versions.

Treat user notes, imported descriptions, retrieved text and model output as untrusted content. Baseline context excludes raw untrusted free text; prompts still separate fixed policy from bounded data. Prompt injection defenses combine restricted context, no action tools, validation and evaluations; a system prompt alone is not a security boundary. Suggestions require user adoption and deterministic owning-module validation. PR-09 must evaluate injection, leakage, unsupported numerics, sparse-context inference and provider failures before release; model/provider/output design is not permission to weaken this boundary.
