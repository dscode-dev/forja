# 0001 — Foundation ownership

- Status: Accepted
- Date: 2026-10-04
- Scope: [PR-00](../prs/PR-00.md)
- Canonical owners: [architecture](../architecture.md), [domain documents](../domains/financial.md), [security gate](../security.md)
- Acceptance evidence: user approved the stack/principles and authorized establishing module and Unity boundaries in PR-00. This does not imply review approval of subsequent specifications.
- Supersedes/superseded by: none

## Context
The inspected workspace was intentionally empty and had no Git metadata. The user subsequently supplied the approved roadmap. Future agents need stable ownership and explicit gates before building features.

## Decision
Establish the linked canonical documents and their authority. Backend/Unity ownership and dependency boundaries are selected for this foundation; detailed security remains a subsequent gated decision.

## Alternatives
A single growing instruction file would force every agent to read unrelated rules. Duplicating rules in each PR would create competing sources of truth. Both are rejected in favor of a concise entrypoint and domain owners.

## Consequences and validation
Each future PR must reference its domain owner and resolve scoped prerequisites. Validate links, unique ownership and consistent dependency gates. Roadmap dependency refinements must preserve the supplied PR identities and scope.
