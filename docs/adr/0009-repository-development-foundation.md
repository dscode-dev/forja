# 0009 — Repository and development foundation

- Status: Accepted
- Date: 2026-10-04
- Scope: [PR-01](../prs/PR-01.md)
- Canonical owner: [development](../development.md), [mobile workflow](../mobile-development.md)
- Acceptance authority: user delegated platform/tooling selection in PR-01; runtime evidence is recorded in its specification.
- Supersedes/superseded by: none

## Context and decision

A documentation-only workspace needs reproducible backend tooling and a native Hub project without product features. Use simple apps/api + apps/mobile, Docker-pinned Node/PostgreSQL, exact npm lockfile and explicit node-postgres/node-pg-migrate rather than ORM automatic schema mutation or a monorepo task framework. Node built-in tests cover platform boundaries without an extra test-runner/transpiler stack. Unity LTS pin is expected, not a fabricated installed version.

The Editor policy portion is superseded by [0010](0010-unity-supported-editor.md).

## Consequences and scope refinement

PR-01 supplies minimal platform bootstrap/connectivity/migration bookkeeping; PR-02 still owns domain-ready persistence/security adapters. The user's explicit PR-01 security exclusions defer KMS/lifecycle provisioning to that adapter specification; no sensitive persistence bypass exists. Hosting/CI provider selection remains separate; portable validation entrypoints are ready for attachment. Physical iPhone 15 Pro Max validation is pending developer evidence, independent of static checks.
