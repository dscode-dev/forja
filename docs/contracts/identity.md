# Identity wire contract v1

Behavior/security/classification: [Identity](../identity.md), [mobile security policy](../security.md#unitymobile-security-contract). All responses prohibit caching; JSON requests maximum 8 KiB. Unknown body fields are rejected. No owner/key/status assignment exists.

| Route | Request / response |
| --- | --- |
| POST /v1/auth/begin | `{codeChallenge,intent}`; intent login/register, S256 challenge 43 base64url characters. 200 `{challengeId,state,nonce,authorizationUrl,expiresIn}` |
| POST /v1/auth/complete | `{challengeId,state,nonce,code,codeVerifier}`; UUID challenge, state/nonce 43 base64url characters, code maximum 2048, verifier 43–128 RFC 7636 characters. 200 token response below |
| POST /v1/auth/refresh | `{refreshToken}`; 200 token response. Single-flight: never retry a consumed credential after an uncertain response; reauthenticate |
| POST /v1/auth/logout | Bearer access; empty body; 204 |
| POST /v1/auth/revoke-all | Bearer access and fresh step-up; empty body; 204 |
| GET /v1/me | Bearer access; 200 `{userId,revision,displayName,locale,timezone,preferredCurrency,onboardingState}` |
| PUT /v1/me/profile | Bearer access; `{revision,profile:{displayName,locale,timezone,preferredCurrency,onboardingState}}`; complete replacement, 200 updated /me shape |
| DELETE /v1/me | Bearer access and fresh step-up; empty body; 204 after live purge, failure remains denied/pending recovery |

Token response: `{accessToken,refreshToken,tokenType:"Bearer",expiresIn:300}`. Both tokens are opaque base64url CSPRNG values, 43 characters. Never derive identities from tokens or expose/store server crypto keys. Access validity is also capped by current session/account expiry/revocation. Endpoint paths themselves accept no user ID.

Errors expose only `{code:"REQUEST_REJECTED"|"UNAVAILABLE"|"INTERNAL_ERROR"}`: invalid JSON/schema 400, unauthenticated/replayed/denied credentials 401, required step-up 403, stale revision 409, size 413, throttle 429, dependency/integrity failure 503. Lost registration completion starts a fresh OIDC flow; infrastructure-failed pending accounts reconcile rather than receive a session. Login never registers an unknown identity.

Unity PR-06 owns OS browser/callback handling, single-flight refresh, secure-storage/logout/background behavior and physical device verification; this PR adds no Unity code. Do not request offline financial writes or persist financial/profile responses in client caches.
