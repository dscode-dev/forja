# Backend persistence foundation

Canonical platform persistence conventions established by PR-02. Policy remains in [security](security.md); money/consistency semantics remain in [financial domain](domains/financial.md). Identity entities are owned by [Identity](identity.md); no financial entities exist.

## PostgreSQL and transaction ownership

Use node-postgres through Platform Database. SQL is parameterized inside explicit bounded-context persistence adapters; application/domain rules do not import pg, Nest or a generic repository. UserKeyRepository is justified by cryptographic ownership and wrapper-only persistence, not a CRUD base class.

Database.transaction leases one connection, begins a transaction, awaits the use case and registered beforeCommit guards, commits and releases. Failures roll back all writes; escaped handles reject further use. Lock ordering/idempotency/projection writes belong to Finance's future adapter. No automatic retry: conflict is a safe typed failure, commit_unknown means reconcile durable effects before retry. Pool limits/timeouts bound connections/statements; shutdown denies new queries and drains leased work.

Migrations run explicitly under the migrator role; API has no schema CREATE or schema_migrations privileges. PR-02 added app.user_data_keys; PR-03 binds its owner FK to real accounts and adds owner/key-constrained encrypted profiles and safe security audit. No users are seeded. PG key state is an operational mirror; external lifecycle state is authoritative for key access.

The key migration refuses destructive down execution. Recovery is a reviewed forward migration after dependent wrap/backup inventory, not DROP TABLE. Test-only migration rollback fixtures verify DDL atomicity in forja_test. [Commands](development.md#commands--repository-root) own developer entrypoints.

## Cryptographic boundary

CryptoPlatform composes KeyProtectionProvider, KeyLifecycleStore, UserKeyRepository and UserKeyService. Contracts allow asynchronous external control I/O; the current local adapter is synchronous only inside development infrastructure. No vendor adapter or empty production substitute exists. Production startup is rejected until managed key protection and independent production control custody are selected, implemented and verified.

PR-03 supplies trusted principal and identity-binding digest before any key lookup. Never derive expected identity, owner, environment, entity or slot from client ciphertext/PG header. withKey admits one bounded operation, unwraps for its lifetime, and exposes async encrypt/decrypt plus transaction guard; await all operations inside the callback. UserKeyService.transaction registers lifecycle admission verification before commit. Decrypted buffers and raw DEKs are cleared on scope exit; managed-memory copies retain the residual risk documented in security. Never cache a scope/key or return decrypted buffers from it.

Low-level envelope seal/open are internal primitives for the admitted service and conformance tests, not an alternative allocator/API. Future adapters supply versioned typed payload/metadata schemas, validate JSON before encryption, and use only classified metadata in AAD. Preserve canonical serialized envelope strings (validated text), rather than JSONB reordering or ad hoc stringify of driver objects. The strict parser rejects duplicate keys, extra fields and noncanonical representations. Per-record financial content is not enabled by this PR.

Pending creation persists wrap, independently enrolls its fingerprint, verifies authenticated unwrap under a maintenance admission, activates after drain and synchronizes the PG mirror. Reconciliation handles interrupted mirror updates. Rewrap fences admission, stages previous/next fingerprints independently, installs via PG CAS and atomically completes external enrollment/reopening; interruption stays closed until reconcile. Retain old wrapping versions. State/counter authorization cannot be rebuilt from PG.

Retirement, live encrypted-entity migration/reference inventory and financial checkpoint anchoring require those entities in PR-04 and operational backup verification before deployment. The foundation never retires live keys automatically. Orphan pending keys remain denied, not guessed active.

## Development custody and control

scripts/dev crypto-open obtains the OS-random development KEK from macOS Keychain and creates a 0600 private runtime delivery file in ignored .local/runtime; values never enter argv/env/Compose text. Keychain is the custodian; runtime delivery is temporary and removed by crypto-close/down. Clean crash residue locally; do not copy runtime files into backups. Test keys are generated solely by test fixtures.

Independent .local/control/lifecycle.sqlite stores metadata, durable counters, admissions, wrapping intents and security journal, outside the PostgreSQL volume. SQLite uses immediate transactions, DELETE journal and EXTRA synchronization; permissions are 0700 directory/0600 file. Versioned control migrations run only through crypto-bootstrap. No automatic allocator recreation: first bootstrap consumes a one-time permit; existing Keychain custody requires the existing store/authority ID. Counter reservation commits before encryption, burns on failure, and uses no reusable ranges. Rotation due is enforced before further writes; hard cap remains independently bounded.

Do not clone/restore a live control directory or reset counters. Foreign authority IDs, absent stores and unknown states deny access. A copied older store with the same valid authority cannot be detected cryptographically by this local adapter; known/suspected control restore/clone requires quarantining all writers and a fresh environment/custody, not reuse of old encryption state. This is a development-only operational limit, not a production rollback guarantee. Crashed-writer admissions never expire automatically: confirm termination before privileged repair; no timeout proves drain.

Local readiness checks actual PG/key-table access, lifecycle integrity, key-provider availability and independent session-authority health, returning only the public health contract. No new telemetry SDK/sink, Redis or pgvector was introduced. Production managed adapter, independent journal/restore drill, legal retention/operations and identity/financial authorization gates remain mandatory before sensitive production use; PR-02 local conformance does not satisfy them.
