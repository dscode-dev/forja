# Financial domain

## Authority and invariants

- The server is authoritative for persisted financial state. Clients submit intents; they cannot directly establish authoritative balances.
- Predicted income != received income. Scheduled debit != completed debit. Receivable != received money.
- AI recommendation != financial transaction. Only an authorized deterministic application command can change financial state.
- Financial calculations are deterministic. LLMs never determine balances, projections or financial state.
- Financial history remains auditable. Corrections retain the original event and link the adjustment; no silent rewriting or deletion of posted history. Authorized privacy deletion follows the distinct lifecycle in [security](../security.md); ordinary correction is not erasure.
- A retried command cannot post the same financial effect twice. Settlement cannot count both an expectation and its realization as received/spent money.

## Model boundaries

Finance owns actual financial facts and their provenance: accounts, posted income/expenses, balance effects, debt principal/settlements and correction history. Opening balances or imported snapshots require an explicit authorized provenance and reconciliation policy; a client number is not self-authenticating.

Planning owns expectations: future debits, receivables, predicted income, emergency reserve targets, goals and projection inputs. Expected items affect forecasts only. Marking them realized requires a linked Finance result. Cancellation of an expectation does not reverse a posted financial effect.

Debt is an obligation, not available money. Borrowed funds, outstanding principal, repayments, interest and fees need separate classifications. Reserve contributions must distinguish transfers from expenses; goal progress must not double-count the same funds. Accounts, allocations and reporting classifications are defined in the implementing PR before use.

Work owns career/profile and availability inputs. Planning consumes confirmed assumptions to derive required daily/hourly income. Reporting reads deterministic facts and projections separately; AI receives approved summaries through its own boundary.

## Calculation contract

Use exact money representations; binary floating-point is forbidden for financial arithmetic. Every amount carries a currency. Currency precision, rounding, rate precision and conversion policy must be decided before monetary persistence/calculation implementation. Do not aggregate mixed currencies without an approved conversion policy.

Every derived result identifies its inputs, effective time/period, timezone, currency, assumptions and formula version. Same validated inputs and rule version produce the same result. Persist or reconstruct sufficient provenance under the security policy; never emit sensitive inputs to telemetry.

Required income must define the time horizon, eligible working days/hours, net/gross interpretation, known receipts, obligations and shortfall. Zero available time must yield a defined non-numeric/error outcome, never infinity or a fabricated income target. Forecasts and reports visibly distinguish realized facts from estimates.

Daily/weekly/monthly/custom periods need explicit timezone and boundary rules. Settlement, corrections and late-arriving facts must have defined effects on historical reports.

## Decisions required by dependent PRs

Before Finance: currencies/precision, posting model, opening balances, sources/reconciliation, command idempotency and correction semantics. Before Planning: obligation/settlement states, reserve allocations, projection and required-income formulas. Before Reporting: period rules, restatement and formula provenance. Financial-data encryption follows the finalized [security contract](../security.md).

## Encrypted financial state and bounded reads

The [security contract](../security.md) owns classification, envelopes, AAD, nonce/key handling and retention. This section owns deterministic persistence/processing consistency. All financial payloads, including balances, projections, bucket aggregates and audit details, are S3; operational selectors alone may be indexed. Do not use plaintext amount columns, SQL `SUM(amount)`, amount hashes/blind indexes, full-text sensitive search or deterministic encryption.

Use an append-only ordered per-user financial event stream and encrypted current account state plus encrypted period buckets. This is a local persistence model inside Finance, not a generic event-sourcing framework or new service. A logical correction appends an event; key migration may replace its encrypted representation without changing logical content/sequence. Each state records authenticated input cursor, rule/schema version and last update revision. A baseline checkpoint starts with approved opening/source facts, not fabricated zeroes.

| Capability | Read/compute strategy |
| --- | --- |
| History | Owner/account/time/sequence selects indexed S1 metadata; cursor pagination, maximum 100 records/page; authorize then authenticate/decrypt selected payloads only |
| Balance | Read encrypted account projection at its committed stream cursor; authenticate before returning; no sum of unlimited history per request |
| Daily/monthly actuals | Persist encrypted per-account/currency/UTC-date contribution buckets and cumulative checkpoints as part of posting. Month/user-timezone/custom summaries deterministically combine selected buckets and boundary events; label currency and rule provenance |
| Scheduled/receivable obligations and forecasts | Query indexed owner/account/date/technical realization state, authenticate encrypted payloads and relevant metadata, compute bounded expected-state projections separately from posted balances |
| Goals/reserve allocations | Encrypted deterministic state links approved underlying funds/settlements; state and contribution changes use transactional revisions, avoiding duplicate allocation/expense counting |
| Reports | Reporting composes Finance/Planning/Work public results. Daily/weekly/monthly/custom view semantics follow its approved period rules; never reinterpret UTC buckets as a user's local day without boundary reconciliation |

Interactive reports/forecasts process at most 1,000 input buckets/events/expectations per request. Beyond that, return an explicit accepted/background job or bounded-period requirement; no silent truncation. Jobs read immutable cursor/version snapshots in batches of at most 500 items, use encrypted checkpoints/artifacts, release key/plaintext after each batch, and have explicit cancellation/retention handling. These are initial operational safety bounds; changing them requires benchmark evidence and a scoped PR, not financial formula changes. Exact timezone/currency/business formulas remain the relevant feature PR's decisions.

### Posting and projection transaction

1. Authenticate/authorize the command; pin an admitted per-user key lifecycle operation, reserve required nonces outside the business transaction and acquire the Finance user-stream guard lock. Lock affected entities in stable ID order. Validate ownership, current revisions, currency and all decrypted/AAD-authenticated input facts. Do not begin financial effects if key authorization/encryption infrastructure is unavailable.
2. Look up the random opaque idempotency key under `(user, command kind, key)`. Store SHA-256 of the versioned canonical command semantics **inside the encrypted receipt**, not as a plaintext financial hash. An equal authorized replay returns the original committed result; reuse for another intent is rejected. Failed attempts do not consume the business idempotency result or reuse crypto allocations.
3. Compute the deterministic effect from validated facts. In **one PostgreSQL transaction**, insert encrypted event/history and encrypted idempotency receipt, update encrypted balances and affected buckets/checkpoints, increment stream/revisions, and insert only opaque outbox facts/references. The authoritative projections reach the new event cursor in the same commit. Failure rolls all these effects back; nonce reservations stay burned.
4. Return only after successful commit. Outbox consumers operate on committed evidence, with their own durable unique consumption/reward identity. Game/Reporting updates may be asynchronous but expose their cursor/staleness; they cannot modify Finance's balances.

Planning settlements use the same local transaction/unit of work: Planning orchestrates its owner-validated state change through Finance's public idempotent settlement command; each module writes only its own records. Acquire the common Finance stream guard before Planning entity locks. Commit actual event, encrypted projections and expected-item realized/link state together. No exposed state may count both the expectation and realization. This introduces no Finance import of Planning or cross-module repository writes. Outbox notification is for downstream consumers, not a substitute for atomic settlement.

### Integrity, replay and rebuild

Metadata restrictions, owner compound FKs/unique constraints and revision CAS supplement AEAD. Store an authenticated previous-event digest chain in each encrypted event and checkpoint using standard SHA-256 of the previous canonical logical event, including sequence and provenance; do not publish plaintext value hashes. Cryptographic re-encryption preserves logical hashes. A key-holder could still rewrite valid records, and a database writer could replay/delete a complete valid chain suffix: neither AEAD nor an in-database hash chain proves freshness by itself.

Publish periodic opaque stream sequence and SHA-256 digest of the **canonical encrypted checkpoint envelope** to the independent lifecycle/security journal after commit. Its encrypted payload binds the cursor, internal logical chain hash and projection provenance. Never expose a digest of plaintext financial values: low-entropy amounts are guessable even when hashed. Keep the referenced encrypted checkpoint snapshot immutable for comparison; authorized re-encryption registers an old-envelope-digest → new-envelope-digest replacement in the external journal after validating unchanged logical content, retaining the supersession trail. Reconciliation records the last externally anchored cursor. A transaction is not withheld for a journal outage after its authoritative DB commit; retry anchoring from the outbox and expose an operational integrity alert. An unanchored tail retains deletion/rollback risk. Recovery compares the trusted journal head with restored history; unexpected missing/altered anchored history is an integrity incident, not automatic acceptance of a lower balance. Full database-write tamper prevention is not claimed.

Rebuild only in an authorized bounded job from authenticated checkpoints/events, with rule versions and an explicit target cursor. CAS/guard ensures replacement is current; validate rebuilt versus committed encrypted state before publish. Missing/authentication-failing facts block the affected result and raise a safe integrity event; never skip records, return a default zero or fabricate a projection. A crash cannot leave an event posted without its authoritative Finance projections. Cross-user reporting/analytics is not approved by this architecture.
