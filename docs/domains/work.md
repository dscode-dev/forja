# Work profile and declared earning capacity

Work owns user-confirmed professional inputs; Planning consumes its authorized application reads. Ownership is in [architecture](../architecture.md); actual/expected money and exact monetary representation remain in [Finance](financial.md). Profession is not verified employment; desired salary is not income; available time is not guaranteed work. Declared capacity != expected receivable != scheduled income != settled income. Work never posts Finance events or creates Planning expectations.

## Profile rule 1

One optional profile per owner, full replacement with optimistic expectedRevision (0 means create). Work status: employed/self-employed/unemployed/student/other. Work model: employment/independent/business/mixed/none. These are descriptions, not eligibility rules; unemployment can coexist with intended capacity. Occupation, up to 20 distinct skills, direction, career target and notes are nullable/bounded private text; no employer/contact/resume or verification data. Career target is an aspiration string, never an amount to add to capacity.

One supported Finance currency covers every component; no FX. Earning model FIXED_MONTHLY/HOURLY/DAILY/PER_PROJECT/VARIABLE has exactly one matching component; MIXED has 2–4 explicit distinct component kinds. HOURLY and DAILY cannot coexist: both would consume the same availability; separate time allocations are outside this compact model. Users consolidate multiple sources of the same kind before declaring; no duplicate or hidden component. AmountMinor uses Finance's nonnegative integer minor-unit strings, including zero. VARIABLE alone permits null amount (unknown); its numeric amount, if supplied, is a declared monthly estimate, not a promised receipt. All components describe gross receipts before taxes/costs; no net-income inference. Recurring declaration is the FIXED_MONTHLY or VARIABLE component, not a duplicate salary field.

Availability: integer availableMinutesPerDay 0–1440, distinct ISO preferredWeekdays 1–7 (Monday–Sunday), maximumMinutesPerWeek 0–10080. Declared available weekly minutes = daily minutes × weekday count, must not exceed the maximum. Empty weekdays require zero daily minutes. committedMinutesPerWeek is nullable, 0–10080: informational committed capacity, separate from the declared *available* minutes; their sum must fit the maximum. No appointment calendar or assumption that committed hours also earn the declared rate.

## Capacity rule 1

Caller selects inclusive UTC civil dates from/through, 1–366 days, and optional immutable profile revision. These dates are a projection horizon, not an employment schedule or historical financial report. ISO weekdays map to UTC dates explicitly; future local-time interpretation requires its own approved rule. Profile revision is held constant over the horizon, even if later updates occur. No interpolation between historical revisions.

| Component | Exact capacity over that horizon |
| --- | --- |
| HOURLY | rateMinor × eligible weekday count × availableMinutesPerDay / 60 |
| DAILY | rateMinor × eligible weekdays with nonzero availableMinutesPerDay; a declared daily rate is for one declared working day, not 24 hours |
| FIXED_MONTHLY | Sum, by intersected Gregorian calendar month, monthlyMinor × included civil days / actual days in that month |
| VARIABLE | Same monthly formula when explicitly declared; otherwise unknown |
| PER_PROJECT | rateMinor × explicit nonnegative projectCount supplied for this horizon (0–1000); absent count is unknown, not zero |
| MIXED | Sum explicit independently calculated components in the same currency/horizon; no repeated use of one component |

Compute rational terms with BigInt. Floor **once per component after accumulating the entire horizon**, toward zero for nonnegative values, then exact-add rounded minor-unit components with Finance's bounds. BigInt rational numerators/denominators are not money amounts; validated monetary results/aggregates must fit Finance's range. No floating point, four-week month or automatic annualization. Return component results and knownSubtotalMinor; totalMinor is null if any component is unknown. Zero time yields zero hourly/daily estimates, not fabricated targets; fixed declarations remain independent of availability. projectCount with no project component is invalid. Project count is a user-declared quantity, not a time-feasibility proof; no project-duration model is inferred.

Response provenance includes profileRevision, recordedAt/effectiveAt, exact horizon/timezone/currency, input availability/components, formulaVersion=1 and assumption codes. Caller-supplied projectCount is returned as an assumption. Example BRL rateMinor=10000, 240 minutes/day, Monday–Friday yields 200000 minor units over a full week. Updating inputs changes only later projections. Goals/required-income/net costs/FX/probabilities and generated expectations are later Planning scope.

## Historical and application reads

Each accepted replacement appends one immutable encrypted snapshot and moves its current pointer atomically under the real user-row guard. effectiveAt = server recordedAt; no backdating or future-dated changes. Revision is the authoritative ordering if millisecond timestamps coincide. Old snapshots remain accessible through an authorized revision read; future persisted calculations must retain that revision and their separate horizon/assumptions. Ordinary UPDATE/DELETE of snapshots is denied; approved Identity erasure purges current pointer then snapshots before wraps.

WorkService.profile(principal, revision?) returns a DTO; capacity(principal, horizon) returns a deterministic projection without Finance reads/writes. careerContext(principal) returns only revision, work status, work model, skills and desired direction: excludes occupation, notes, target and money. This is a private application read for future purpose-approved context preparation, not permission to send raw career text to an LLM. AI consent/minimization remains [AI](ai.md) and [security](../security.md). These reads own a transaction and acquire the common user guard: fetch the immutable Work DTO before opening a Finance/Planning locked unit of work, retain its revision, and never nest a Work read inside an already-held user guard. Later Planning defines the combined snapshot/restatement policy.

## Field classification

[Security](../security.md) owns the classification policy. In this model every profile value (including work/earning status, currency, availability, skills, aspirations, notes and computed capacity) is S3; encrypted snapshots, authorized transient processing only. No S2 field is collected. S1 persisted metadata is limited to owner UUID, revision, recorded/effective timestamp, bounded created/updated/model-changed action, key/envelope routing and ciphertext. Actual earning-model values never enter plaintext action metadata. Safe audit is the immutable snapshot's authenticated action/time; no private values in telemetry.

AAD/persistence mapping is owned by [persistence](../persistence.md). Current pointer must match the latest immutable revision; missing history/pointer, replayed pointer or invalid envelope fails closed. This detects partial replay, not deletion of an entire valid history suffix by a privileged database writer: Work has no external freshness anchor. Finance's independent journal is unchanged. Complete DB-write rollback prevention is not claimed; restore/reference inventory and key migration must include Work before deployment/key retirement.
