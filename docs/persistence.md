# Backend persistence foundation

Canonical platform persistence conventions established by PR-02. Policy remains in [security](security.md); money/consistency semantics remain in [financial domain](domains/financial.md). Identity entities are owned by [Identity](identity.md); Finance/Planning semantics are owned by the financial domain.

## PostgreSQL and transaction ownership

Use node-postgres through Platform Database. SQL is parameterized inside explicit bounded-context persistence adapters; application/domain rules do not import pg, Nest or a generic repository. UserKeyRepository is justified by cryptographic ownership and wrapper-only persistence, not a CRUD base class.

Database.transaction leases one connection, begins a transaction, awaits the use case and registered beforeCommit guards, commits and releases. Failures roll back all writes; escaped handles reject further use. Finance's unit of work owns stream locking/idempotency/projection writes. No automatic retry: conflict is a safe typed failure, commit_unknown means reconcile durable effects before retry. Pool limits/timeouts bound connections/statements; shutdown denies new queries and drains leased work.

Migrations run explicitly under the migrator role; API has no schema CREATE or schema_migrations privileges. PR-02 added app.user_data_keys; PR-03 binds its owner FK to real accounts and adds owner/key-constrained encrypted profiles and safe security audit. PR-04.A adds real Finance/Planning tables; no users or financial facts are seeded. PG key state is an operational mirror; external lifecycle state is authoritative for key access.

The key migration refuses destructive down execution. Recovery is a reviewed forward migration after dependent wrap/backup inventory, not DROP TABLE. Test-only migration rollback fixtures verify DDL atomicity in forja_test. [Commands](development.md#commands--repository-root) own developer entrypoints.

## Cryptographic boundary

CryptoPlatform composes KeyProtectionProvider, KeyLifecycleStore, UserKeyRepository and UserKeyService. Contracts allow asynchronous external control I/O; the current local adapter is synchronous only inside development infrastructure. No vendor adapter or empty production substitute exists. Production startup is rejected until managed key protection and independent production control custody are selected, implemented and verified.

PR-03 supplies trusted principal and identity-binding digest before any key lookup. Never derive expected identity, owner, environment, entity or slot from client ciphertext/PG header. withKey admits one bounded operation, unwraps for its lifetime, and exposes async encrypt/decrypt plus transaction guard; await all operations inside the callback. UserKeyService.transaction registers lifecycle admission verification before commit. Decrypted buffers and raw DEKs are cleared on scope exit; managed-memory copies retain the residual risk documented in security. Never cache a scope/key or return decrypted buffers from it.

Low-level envelope seal/open are internal primitives for the admitted service and conformance tests, not an alternative allocator/API. Entity adapters supply versioned typed payload/metadata schemas, validate JSON before encryption, and use only classified metadata in AAD. Preserve canonical serialized envelope strings (validated text), rather than JSONB reordering or ad hoc stringify of driver objects. The strict parser rejects duplicate keys, extra fields and noncanonical representations. Platform EncryptedRecord handles the shared authenticated JSON codec for actual Finance and Planning consumers; their adapters own the typed schemas and metadata order.

Pending creation persists wrap, independently enrolls its fingerprint, verifies authenticated unwrap under a maintenance admission, activates after drain and synchronizes the PG mirror. Reconciliation handles interrupted mirror updates. Rewrap fences admission, stages previous/next fingerprints independently, installs via PG CAS and atomically completes external enrollment/reopening; interruption stays closed until reconcile. Retain old wrapping versions. State/counter authorization cannot be rebuilt from PG.

Retirement, live encrypted-entity migration/reference inventory and checkpoint re-encryption/supersession require a separately bounded maintenance specification and operational backup verification before deployment. PR-04.A implements local committed checkpoint anchoring. The foundation never retires live keys automatically. Orphan pending keys remain denied, not guessed active.

## Development custody and control

scripts/dev crypto-open obtains the OS-random development KEK from macOS Keychain and creates a 0600 private runtime delivery file in ignored .local/runtime; values never enter argv/env/Compose text. Keychain is the custodian; runtime delivery is temporary and removed by crypto-close/down. Clean crash residue locally; do not copy runtime files into backups. Test keys are generated solely by test fixtures.

Independent .local/control/lifecycle.sqlite stores metadata, durable counters, admissions, wrapping intents and security journal, outside the PostgreSQL volume. SQLite uses immediate transactions, DELETE journal and EXTRA synchronization; permissions are 0700 directory/0600 file. Versioned control migrations run only through crypto-bootstrap. No automatic allocator recreation: first bootstrap consumes a one-time permit; existing Keychain custody requires the existing store/authority ID. Counter reservation commits before encryption, burns on failure, and uses no reusable ranges. Rotation due is enforced before further writes; hard cap remains independently bounded.

Do not clone/restore a live control directory or reset counters. Foreign authority IDs, absent stores and unknown states deny access. A copied older store with the same valid authority cannot be detected cryptographically by this local adapter; known/suspected control restore/clone requires quarantining all writers and a fresh environment/custody, not reuse of old encryption state. This is a development-only operational limit, not a production rollback guarantee. Crashed-writer admissions never expire automatically: confirm termination before privileged repair; no timeout proves drain.

Local readiness checks actual PG/key-table access, lifecycle integrity, key-provider availability and independent session-authority health plus owning Finance/Planning schema/role probes, returning only the public health contract. No new telemetry SDK/sink, Redis or pgvector was introduced. Production managed adapter, independent journal/restore drill, legal retention/operations and identity/financial authorization gates remain mandatory before sensitive production use; PR-02 local conformance does not satisfy them.

## Finance / Planning persistence

Additive migration 1791072000003 creates finance_streams, finance_accounts, finance_events, finance_receipts, finance_buckets, finance_checkpoints, finance_anchor_outbox, planning_expected and planning_expected_events. Every table uses forced owner RLS; predicates always include verified owner. Compound account/currency/key FKs prevent foreign relationships; unique owner/sequence, receipt owner/kind/key, reversal/replacement and expected-settlement identities enforce DB invariants. Positive magnitudes/aggregate bounds are validated in authenticated payloads: PostgreSQL cannot CHECK encrypted values without defeating confidentiality.

Finance.command and its purpose-specific read snapshot acquire the real user row (FOR NO KEY UPDATE, including first stream creation), then the stream row and affected account; Planning locks its expected item only after that common guard. All commands for a user serialize across processes; this deliberate correctness baseline limits same-user throughput, not other owners. Shared Transaction exposes query/beforeCommit only inside the admitted callback; encrypted reads pass that same SQL executor for wrap lookup rather than leasing another pool connection while holding locks; Planning writes its own tables while calling Finance.post. Finance never imports Planning or reads its tables. Unknown commit outcome is reconciled by the original receipt/key; no automatic money retry.

Events/checkpoints/receipts and Planning audit snapshots reject ordinary UPDATE/DELETE via triggers. Authorized deletion first independently denies/fences/drains through Identity; its transaction invokes registered Planning then Finance erasure consumers, purges encrypted rows, then profile/wraps. Trigger DELETE exception requires matching transaction-local erasure owner **and** deletion-requested account status. This is trusted-backend erasure authority, not protection against an adversary who can alter arbitrary database roles/state. Consumers own their writes and registration precedes startup deletion reconciliation; absence of a consumer with surviving FK inventory fails purge/activation closed.

### Persisted field classification and AAD schema 1

All payload values are S3: amounts/balances/names/types/descriptions/source/actor audit details, command fingerprints/results, event logical chain hashes, contribution totals and checkpoint state hashes. Outer schema=1 wraps typed value. Every record authenticates environment/owner/kind/entity UUID/slot=private/revision/schema/key using the existing envelope. Header/key routing is S1; no monetary SQL columns/indexes exist.

| Entity kind | S1 selectors / fixed metadata_values order |
| --- | --- |
| finance.stream | owner UUID (entity), seq |
| finance.account | account UUID (entity), currency, state, last_seq |
| finance.event | event UUID (entity), seq, account_id, currency, effective_at, recorded_at, reversal_of, replacement_of, expected_id |
| finance.receipt | random idempotency UUID (entity), command kind |
| finance.bucket | account UUID (entity), account_id, currency, UTC day, UTC month, last_seq |
| finance.checkpoint | owner UUID (entity), seq |
| planning.expected | expected UUID (entity), account_id, currency, due_at, state, settlement_id |
| planning.expected-audit | expected UUID (entity), empty metadata; revision identifies immutable lifecycle snapshot; all audit details encrypted |

Table owner/key/version/revision/payload columns follow the shared envelope binding. Technical state/command kind disclose bounded operational action, never inferred financial health. finance_anchor_outbox stores only owner/seq; independent financial_anchors stores owner/seq/digest of canonical **ciphertext envelope**/created time. Logical plaintext hashes never enter indexes/journal/logs. These selectors fall within the existing security S1 exception; they remain restricted personal metadata.

Indexes implement account UUID pagination; owner/account/sequence history/latest event; owner/account/effective-date history; owner/account/month/day buckets; owner/account/state/due expected work. Bounded financial reads authenticate selected rows and checkpoints, and account projections match indexed last event. A separate additive date/cursor expression index (migration 1791072000004) verifies each bucket against the last event for that UTC date; missing/stale buckets fail rather than restart at zero. Planning reads/transitions authenticate the current immutable audit revision and reject replayed lifecycle snapshots. Planning computes its ≤1,000-input future summary inside the same Finance read unit of work, without storing another mutable truth. Daily buckets support later bounded monthly/period summaries; no lifetime SQL money aggregate or generic projection engine exists.

Independent local control schema **4** explicitly adds financial_anchors while preserving schema-3 identity/lifecycle/counters. crypto-bootstrap must upgrade existing authority before restarting API. Anchoring after commit uses immutable checkpoint envelope digests; duplicate same snapshot is accepted, different digest at same owner/seq fails. The external highest anchored cursor must exist unchanged and cannot exceed the DB head; DB rollback alone cannot lower it. Retry references are durable and deleted only after anchoring; subsequent commands and the owner reconciliation endpoint process 100/batch. A journal outage logs only finance.anchor/unavailable; authoritative commit remains successful and the unanchored suffix risk is explicit. Full recovery chain/reference inventory and managed journal adapters remain release gates.

Normal runtime cannot re-encrypt immutable history. A future authorized maintenance implementation must authenticate unchanged logical content, preserve digests/cursors and record external ciphertext supersession before any live-key retirement; trigger bypass alone is forbidden. Missing/corrupt state blocks reads/writes; no automatic zero, skipped record or regeneration from unauthenticated facts.
