# Finance and Planning v1 wire contracts

Business semantics: [financial domain](../domains/financial.md). Auth/session/error/transport policy: [Identity contract](identity.md), [security](../security.md). All routes require Forja bearer authentication; responses/errors are no-store. Strict JSON rejects extra fields; maximum body 8 KiB. No owner/key/ciphertext parameters.

Money is a canonical signed integer minor-unit string; currencies come from the domain catalogue. Magnitudes for actual/expected flows are positive. Dates are canonical UTC timestamps with milliseconds. idempotencyKey is a fresh lowercase random UUID, retained by the caller until its result is reconciled; command retry reuses identical body/key. POST success 200; anchor reconciliation success 204. No automatic retry after lost refresh or financial commit uncertainty.

| Method / path (prefix /v1) | Body / query |
| --- | --- |
| POST finance/accounts | idempotencyKey, name (1–500 chars), type (cash/savings), currency, openingMinor (explicit signed baseline), openedAt, source=user-confirmed |
| GET finance/accounts | after? (account UUID), limit? (1–100) |
| POST finance/accounts/:id/close | idempotencyKey |
| POST finance/postings/income or expense | idempotencyKey, accountId, amountMinor, effectiveAt, note (1–500 chars) |
| GET finance/accounts/:id/history | after? (exclusive global sequence, default 0), limit? (1–100) |
| POST finance/events/:id/reverse | idempotencyKey |
| POST finance/events/:id/correct | idempotencyKey, kind=income/expense, amountMinor, effectiveAt, note |
| POST finance/anchors/reconcile | empty object; bounded retry of this authenticated user's committed journal outbox |
| POST planning/expected | idempotencyKey, accountId, currency, dueAt, kind=predicted-income/receivable/scheduled-debit/payable, amountMinor, note, source=user-confirmed |
| GET planning/expected/summary | accountId, through (explicit future/current UTC timestamp) |
| GET planning/expected | accountId (required), after? (entry UUID), limit? (1–100) |
| POST planning/expected/:id/settle | idempotencyKey, effectiveAt (confirmed actual timestamp) |
| POST planning/expected/:id/cancel | idempotencyKey |

Commands return `{accountId,eventIds,expectedId,state,seq}`; nullable IDs are explicit and eventIds is empty/one/two. This is the original committed result on retry, not the current account balance. Correction returns reversal then replacement IDs. seq is the committed global financial cursor; expectation-only commands leave it unchanged.

Accounts response `{accounts,cursor,next,rule:1}`: each account includes id/currency/minorDigits/state/revision/cursor, name/type/balanceMinor/openedAt/lastEvent/rule. No total across accounts/currencies is implied; next signals a further page. History `{events,cursor,next,rule:1}` returns selected actual events with id/seq/accountId/currency/effectiveAt/recordedAt/reversalOf/replacementOf and decrypted kind/state/previousState/nextState/classification/deltaMinor/note/source/previousHash/commandKind/commandKey/actor/expectedId. State is always posted; reversal is a separate linked posted effect, not a change to the original.

Expected list `{entries,next,evaluatedAt}` includes id/accountId/currency/dueAt/state/settlementId/revision and kind/amountMinor/note/source/status. Derived status is predicted-income, scheduled-debit, expected-receivable, overdue-receivable, expected-payable, overdue-payable, received, paid or cancelled. Never add these amounts to balanceMinor. Forecast UX, work-capacity/goals and report presentation are later contracts.

400 invalid shape/money/date; 401 denied identity/session; 404 unavailable owned entity (foreign IDs behave the same); 409 stale lifecycle/duplicate realization/reversal/conflicting retry/currency; 429 exhausted safety cap; 503 custody/integrity/dependency/commit uncertainty. Bodies contain only public error codes, never source details. Resolve uncertainty by replaying the original command; a failed attempt has no receipt.

Summary returns accountId/currency, settledBalanceMinor/projectedBalanceMinor, expectedIncomingMinor/expectedOutgoingMinor, predictedIncomeMinor/receivableMinor/scheduledDebitMinor/payableMinor, overdueReceivableMinor/overduePayableMinor, asOf/through, financialCursor/accountCursor/accountRevision, expectedInputs=[{id,revision}], rule=1 and the fixed assumptions identifier. Business formula/limits are canonical in the financial domain; projected and expected totals must be labeled estimates separately from available cash. Reserve allocation is outside this contract. More than 1,000 inputs returns 422 `{code:"BOUNDED_PERIOD_REQUIRED"}`.
