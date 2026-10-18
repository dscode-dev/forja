# Reporting v1 / Crônicas

Business semantics: [Reporting](../domains/reporting.md); storage: [persistence](../persistence.md#reporting-persistence). Existing financial/identity/game routes are unchanged. All routes below use the existing AuthGuard, owner authorization, strict body/query fields, bounded 8-KiB request body and no-store responses. No client metric/source cursor/owner/completion field is accepted. Missing/foreign/expired/removed artifact returns safe 404; unknown-commit writes require reconciliation/replay, never automatic new identity.

| Method/path | Request / response |
| --- | --- |
| GET /v1/reports/periods | No query. reportVersion=1, today (server date in Identity timezone), timezone, locale |
| POST /v1/reports/daily, weekly, monthly, custom | Body {idempotencyKey:UUIDv4, accountId:UUID, from:YYYY-MM-DD, through:YYYY-MM-DD}. Non-custom uses equal reference dates; server expands week/month. Returns complete immutable Chronicle, 200 |
| GET /v1/reports/chronicles | after=owner generation (default 0), limit 1–50 (default 20). {chronicles:[{id,generation,generatedAt,expiresAt,period,accountId,currency}],next:integer or null}; ascending generations, only retained artifacts |
| GET /v1/reports/chronicles/:id | No query. Complete immutable Chronicle |
| DELETE /v1/reports/chronicles/:id | No query/body; deletes own artifact early, preserves minimal encrypted command audit, 204; repeated deletion is safe |

To regenerate, POST the chosen period with a **new** UUIDv4. Same key/equal normalized command returns the same snapshot, including its original timezone, even after profile changes. Conflicting intent returns 409. Replaying after removal/expiry returns 404 and cannot create a new snapshot. Generation sequences are owner-wide version identifiers; multiple versions of one period coexist while retained. Errors use the existing sanitized contract; 422 BOUNDED_PERIOD_REQUIRED never contains a partial report. Custom input is 1–366 civil days. Normalized commands support dates accepted by Work's Gregorian input contract; preceding comparison must also resolve within that supported range.

Chronicle shape (money/percentage strings are authoritative; no client arithmetic):

- id, generation, expiresAt, reportVersion=1, generatedAt; request={accountId,type,from,through} retains original command labels.
- period={type,timezone,current:{from,through,start,end},previous:{from,through,start,end},partial,comparison:'full-previous-civil-period'}; UTC bounds are inclusive start/exclusive end.
- locale, tzdb, identityRevision: frozen display/time provenance; no identity/name/contact data.
- finance={accountId,currency,accountRevision,accountCursor,financeCursor}; selected account only.
- settled and previous={incomeMinor,expenseMinor,netMinor,openingMinor,closingMinor,baselineChangeMinor}.
- comparisons={income,expense,net}; each {deltaMinor,percentageBasisPoints:string|null,reason:'ZERO_BASELINE'|'ABSOLUTE_PREVIOUS_DENOMINATOR'}. Basis points are hundredths of one percent, rounded server-side; can exceed money's magnitude bound and must not be parsed as money.
- planning={observation:'pending-at-generation',predictedIncomeMinor,receivableMinor,scheduledDebitMinor,payableMinor,plannedNetMinor,references:[{id,revision}]}: current pending observations due in period, not a reconstructed historical backlog.
- goal=null or {goalId,revision,status,currency,targetMinor,creditedMinor,remainingMinor,calculation}; exclusively attributed current goal. calculation=null or latest frozen {calculationId,generation,formulaVersion,goalRevision,workRevision,financeCursor,identityProfileRevision,asOf,from,through,timezone,currency,conservative,planned,stale}. Scenario/rate shape is [Planning's contract](goals.md). Preserve calculation's own currency/horizon; stale is true for an earlier observation or known source mismatch, never proof of current earning requirements.
- work=null or {revision,recordedAt,formulaVersion,currency,from,through,interpretation:'declared-scenario-over-report-civil-labels',availableMinutesPerWeek,totalMinor:null|string,incomeMinusCapacityMinor:null|string}. Currency mismatch/unknown capacity leaves comparison null.
- game={curveVersion,awardSequence,xp,level,nextLevelXp,xpToNextLevel,xpGained,missionsCompleted,reserveGoalId:null|UUID}; period gains use immutable award times; level/current XP are generation-time observations. Virtual XP is never money.
- reserve=null or {goalId,goalRevision,creditedMinor,remainingMinor,movement:null}. Requires explicit active/completed reserve template with matching goal funding/target/currency; no inferred savings reserve or historical movement.
- inputsRead: bounded selected input count, technical explainability rather than private telemetry.

Internal reads: Finance.reportFacts accepts its guarded read unit, account and ordered previous/current UTC intervals; returns authenticated realized metrics and references. Planning.reportFacts returns minimized authenticated pending sums/references in that unit. Goals.reportFacts authenticates current exclusive attribution and latest calculation using the same transaction. Game.reportFacts authenticates XP/selected awards and explicit reserve identity under the caller guard. These expose no financial commands; no nested owner-lock transactions. Reporting.alchemistFacts returns compact period/currency/settled/deltas/pending summaries, goal deficit/required-income with its own currency/horizon/staleness, Work capacity/currency comparison and virtual gains/current level, without identity, entity IDs, timezone or raw history. This projection remains S3; no provider use/consent is authorized here.
