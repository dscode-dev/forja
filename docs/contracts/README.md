# Shared contracts

PR-01 exposes only operational `GET /health/live` (process liveness) and `GET /health/ready` (PostgreSQL, key/lifecycle and independent session-authority and installed Finance/Planning schema readiness): HTTP 200 with `{ "status": "ok" }`; readiness failure is HTTP 503 with `{ "code": "UNAVAILABLE" }`. Both prohibit response caching. Other errors expose bounded `REQUEST_REJECTED`/`INTERNAL_ERROR` codes, no exception/body details.

Game/AI contracts do not exist yet. Their owning PR specifies and validates real contracts before Unity integration; do not add synthetic JSON responses or hand-copied authoritative state. This directory owns cross-runtime wire contracts only, not business/security rules.

PR-03 adds [identity v1](identity.md). Operational health describes platform readiness; missing OIDC enrollment makes authentication unavailable, never a test identity. Production ingress must gate identity traffic on actual provider/custody readiness.

PR-04.A adds [Finance and Planning v1](finance.md), with real owner-isolated actual/expected semantics; no Unity integration is included.
