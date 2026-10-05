# 0012 — OIDC authentication and independent opaque sessions

- Status: Accepted
- Date: 2026-10-04
- Authority: PR-03 explicitly delegates authentication/session selection within PR-00.SEC; no provider account/vendor provisioning authorized.
- Canonical owner: [Identity](../identity.md); wire shape: [contract](../contracts/identity.md).
- Supersedes: none.

Select OIDC Authorization Code + S256 PKCE through maintained openid-client, an operator-allowlisted public client and opaque subject. Native apps use an external browser as required by [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252/); replay protections follow [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html). Explicit issuer/audience/expiry/nonce and signature verification follow [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html). Passwords would require the separate credential-specific review prohibited as an implicit PR-03 default; social login has no requirement.

Use short-lived random bearer access and rotating refresh verifiers with independent revocation, not a JWT accepted solely from a writable financial DB. The existing independent development control store is extended with versioned auth tables, preserving the approved modular monolith and PG isolation. Auth contracts support asynchronous production adapters. No signing secret or Redis is introduced.

Real issuer/client/callback enrollment is unresolved and blocks deployment integration, not library/protocol conformance testing. Test providers/keys exist only under tests; runtime configuration never fabricates identities. Local physical control rollback limits and managed production custody gates from PR-02 continue to apply. Independent production session storage and network abuse controls must be verified with the selected deployment.
