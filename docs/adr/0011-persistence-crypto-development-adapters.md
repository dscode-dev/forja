# 0011 — Explicit transactions and independent development crypto custody

- Status: Accepted
- Date: 2026-10-04
- Authority: PR-02 delegates foundational adapter/convention choices within PR-00.SEC; no managed vendor selection authorized.
- Canonical owners: [persistence](../persistence.md), [development](../development.md).
- Supersedes: none; extends PR-01 persistence selection without changing security policy.

Use explicit node-postgres transactions and one justified wrapped-key adapter. No generic repository/ORM or business schema. Choose built-in Node crypto for approved AEAD and node:sqlite for a separately persisted development control store, with durable atomic counters/admissions/journal. SQLite is local infrastructure, not the product database or a microservice. Keychain custody and strict production rejection distinguish local wrapping from managed KMS.

This avoids a vendor commitment and makes local conformance executable. External contracts support asynchronous production I/O. Production cannot start until real managed protection and independently permissioned control adapters pass security verification. Local physical-file rollback/clone detection and hosted Linux CI custody are not claimed. Live-entity rotation/backup/retirement evidence follows entity and deployment availability, never weakens policy.
