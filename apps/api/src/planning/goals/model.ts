import { Currency, currency, minor, add } from '../../finance/money';
import { object, text } from '../../identity/validation';
import { id, instant } from '../../finance/validation';
import { date, integer } from '../../work/model';
import { PlatformFailure } from '../../platform/failure';
export const statuses = ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'] as const;
export type GoalStatus = (typeof statuses)[number];
export const actions = [
  'created',
  'revised',
  'paused',
  'resumed',
  'completed',
  'cancelled',
] as const;
export interface Goal {
  title: string;
  description: string | null;
  targetMinor: string;
  currency: Currency;
  startDate: string;
  deadline: string;
  fundingAccountId: string;
  retainedEarningsBasisPoints: number;
}
export interface GoalSnapshot {
  goal: Goal;
  status: GoalStatus;
  action: (typeof actions)[number];
  completion: {
    financeCursor: number;
    accountRevision: number;
    creditedMinor: string;
  } | null;
}
export function nonnegative(value: unknown): string {
  const n = minor(value);
  if (n < 0n) throw new PlatformFailure('invalid');
  return n.toString();
}
function privateText(value: unknown, max: number): string {
  return text(text(value, max).normalize('NFC').trim(), max);
}
export function goal(value: unknown): Goal {
  const b = object(value, [
    'title',
    'description',
    'targetMinor',
    'currency',
    'startDate',
    'deadline',
    'fundingAccountId',
    'retainedEarningsBasisPoints',
  ]);
  const startDate = date(b['startDate']),
    deadline = date(b['deadline']);
  if (startDate > deadline) throw new PlatformFailure('invalid');
  return {
    title: privateText(b['title'], 120),
    description:
      b['description'] === null ? null : privateText(b['description'], 500),
    targetMinor: minor(b['targetMinor'], true).toString(),
    currency: currency(b['currency']),
    startDate,
    deadline,
    fundingAccountId: id(b['fundingAccountId']),
    retainedEarningsBasisPoints: integer(
      b['retainedEarningsBasisPoints'],
      10000,
    ),
  };
}
export function snapshot(value: unknown): GoalSnapshot {
  const b = object(value, ['goal', 'status', 'action', 'completion']);
  if (
    !statuses.includes(b['status'] as GoalStatus) ||
    !actions.includes(b['action'] as GoalSnapshot['action'])
  )
    throw new PlatformFailure('invalid');
  let completion: GoalSnapshot['completion'] = null;
  if (b['completion'] !== null) {
    const c = object(b['completion'], [
      'financeCursor',
      'accountRevision',
      'creditedMinor',
    ]);
    completion = {
      financeCursor: integer(c['financeCursor'], Number.MAX_SAFE_INTEGER, 1),
      accountRevision: integer(c['accountRevision'], 2147483647, 1),
      creditedMinor: nonnegative(c['creditedMinor']),
    };
  }
  const result = {
    goal: goal(b['goal']),
    status: b['status'] as GoalStatus,
    action: b['action'] as GoalSnapshot['action'],
    completion,
  };
  if (
    (result.action === 'created' && result.status !== 'ACTIVE') ||
    (result.action === 'revised' &&
      !['ACTIVE', 'PAUSED'].includes(result.status)) ||
    (result.action === 'paused' && result.status !== 'PAUSED') ||
    (result.action === 'resumed' && result.status !== 'ACTIVE') ||
    (result.action === 'completed' && result.status !== 'COMPLETED') ||
    (result.action === 'cancelled' && result.status !== 'CANCELLED')
  )
    throw new PlatformFailure('invalid');
  if (
    (result.status === 'COMPLETED') !== (completion !== null) ||
    (completion &&
      minor(completion.creditedMinor) < minor(result.goal.targetMinor))
  )
    throw new PlatformFailure('invalid');
  return result;
}
function frozenDate(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new PlatformFailure('invalid');
  return value;
}
export function localDates(timezone: string): (timestamp: string) => string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (timestamp) => {
    const parts = formatter.formatToParts(new Date(timestamp));
    const part = (name: string) => parts.find((p) => p.type === name)!.value;
    const label = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
    return label.length === 10 ? frozenDate(label) : label;
  };
}
export function localDate(timestamp: string, timezone: string): string {
  return localDates(timezone)(timestamp);
}

function daysInMonth(d: Date): number {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
}
export function calendar(
  from: string,
  through: string,
  availability: { minutesPerDay: number; weekdays: number[] } | null,
) {
  date(from);
  date(through);
  const days = Math.max(
    0,
    (Date.parse(through) - Date.parse(from)) / 86400000 + 1,
  );
  let workdays: number | null = null,
    minutes: number | null = null;
  if (availability) {
    workdays =
      availability.minutesPerDay === 0
        ? 0
        : Math.floor(days / 7) * availability.weekdays.length;
    if (availability.minutesPerDay > 0)
      for (let n = 0; n < days % 7; n++)
        if (
          availability.weekdays.includes(
            new Date(Date.parse(from) + n * 86400000).getUTCDay() || 7,
          )
        )
          workdays++;
    minutes = workdays * availability.minutesPerDay;
  }
  let monthNumerator = 0n,
    monthDenominator = 1n;
  if (days) {
    const a = new Date(from),
      z = new Date(through),
      aDays = daysInMonth(a),
      zDays = daysInMonth(z),
      gap =
        (z.getUTCFullYear() - a.getUTCFullYear()) * 12 +
        z.getUTCMonth() -
        a.getUTCMonth();
    if (gap === 0) {
      monthNumerator = BigInt(days);
      monthDenominator = BigInt(aDays);
    } else {
      monthDenominator = BigInt(aDays * zDays);
      monthNumerator =
        BigInt(aDays - a.getUTCDate() + 1) * BigInt(zDays) +
        BigInt(z.getUTCDate()) * BigInt(aDays) +
        BigInt(gap - 1) * monthDenominator;
    }
  }
  return {
    days,
    workdays,
    minutes,
    monthExposure: {
      numerator: monthNumerator.toString(),
      denominator: monthDenominator.toString(),
    },
  };
}
export interface ExpectedInput {
  id: string;
  revision: number;
  kind: 'predicted-income' | 'receivable' | 'scheduled-debit' | 'payable';
  dueAt: string;
  dueLocalDate: string;
  amountMinor: string;
}
export interface CalculationInput {
  formulaVersion: 1;
  goalRevision: number;
  status: GoalStatus;
  targetMinor: string;
  currency: Currency;
  startDate: string;
  deadline: string;
  retainedEarningsBasisPoints: number;
  asOf: string;
  calculationDate: string;
  timezone: string;
  identityProfileRevision: number;
  work: {
    revision: number;
    recordedAt: string;
    currency: Currency;
    minutesPerDay: number;
    weekdays: number[];
    capacityMinor: string | null;
    capacityReason:
      'known' | 'unknown-components' | 'work-horizon-bound' | 'expired';
    monthlyDeclaredMinor: string | null;
    projectCount: number | null;
  } | null;
  finance: {
    cursor: number;
    accountId: string;
    accountCursor: number;
    accountRevision: number;
    balanceMinor: string;
  };
  expected: ExpectedInput[];
}
export function calculationInput(value: unknown): CalculationInput {
  const b = object(value, [
    'formulaVersion',
    'goalRevision',
    'status',
    'targetMinor',
    'currency',
    'startDate',
    'deadline',
    'retainedEarningsBasisPoints',
    'asOf',
    'calculationDate',
    'timezone',
    'identityProfileRevision',
    'work',
    'finance',
    'expected',
  ]);
  if (
    b['formulaVersion'] !== 1 ||
    !statuses.includes(b['status'] as GoalStatus)
  )
    throw new PlatformFailure('invalid');
  const startDate = date(b['startDate']),
    deadline = date(b['deadline']),
    asOf = instant(b['asOf']),
    timezone = text(b['timezone'], 64, /^[A-Za-z0-9_+/-]+$/u),
    calculationDate = frozenDate(b['calculationDate']);
  if (startDate > deadline) throw new PlatformFailure('invalid');
  // Civil interpretation was authenticated at capture; replay must not reapply newer tzdb rules.
  if (
    Math.abs(Date.parse(calculationDate) - Date.parse(asOf.slice(0, 10))) >
    86400000
  )
    throw new PlatformFailure('invalid');
  let work: CalculationInput['work'] = null;
  if (b['work'] !== null) {
    const w = object(b['work'], [
      'revision',
      'recordedAt',
      'currency',
      'minutesPerDay',
      'weekdays',
      'capacityMinor',
      'capacityReason',
      'monthlyDeclaredMinor',
      'projectCount',
    ]);
    if (
      !Array.isArray(w['weekdays']) ||
      w['weekdays'].length > 7 ||
      ![
        'known',
        'unknown-components',
        'work-horizon-bound',
        'expired',
      ].includes(String(w['capacityReason']))
    )
      throw new PlatformFailure('invalid');
    const weekdays = w['weekdays'].map((d: unknown) => integer(d, 7, 1));
    if (new Set(weekdays).size !== weekdays.length)
      throw new PlatformFailure('invalid');
    work = {
      revision: integer(w['revision'], 2147483647, 1),
      recordedAt: instant(w['recordedAt']),
      currency: currency(w['currency']),
      minutesPerDay: integer(w['minutesPerDay'], 1440),
      weekdays,
      capacityMinor:
        w['capacityMinor'] === null ? null : nonnegative(w['capacityMinor']),
      capacityReason: w['capacityReason'] as NonNullable<
        CalculationInput['work']
      >['capacityReason'],
      monthlyDeclaredMinor:
        w['monthlyDeclaredMinor'] === null
          ? null
          : nonnegative(w['monthlyDeclaredMinor']),
      projectCount:
        w['projectCount'] === null ? null : integer(w['projectCount'], 1000),
    };
    if (
      (work.capacityReason === 'known') !== (work.capacityMinor !== null) ||
      (!work.weekdays.length && work.minutesPerDay > 0)
    )
      throw new PlatformFailure('invalid');
  }
  const f = object(b['finance'], [
    'cursor',
    'accountId',
    'accountCursor',
    'accountRevision',
    'balanceMinor',
  ]);
  const finance = {
    cursor: integer(f['cursor'], Number.MAX_SAFE_INTEGER, 1),
    accountId: id(f['accountId']),
    accountCursor: integer(f['accountCursor'], Number.MAX_SAFE_INTEGER, 1),
    accountRevision: integer(f['accountRevision'], 2147483647, 1),
    balanceMinor: minor(f['balanceMinor']).toString(),
  };
  if (
    finance.accountCursor > finance.cursor ||
    !Array.isArray(b['expected']) ||
    b['expected'].length > 1000
  )
    throw new PlatformFailure('invalid');
  const expected = b['expected'].map((v: unknown) => {
    const e = object(v, [
      'id',
      'revision',
      'kind',
      'dueAt',
      'dueLocalDate',
      'amountMinor',
    ]);
    if (
      ![
        'predicted-income',
        'receivable',
        'scheduled-debit',
        'payable',
      ].includes(String(e['kind']))
    )
      throw new PlatformFailure('invalid');
    const result = {
      id: id(e['id']),
      revision: integer(e['revision'], 2147483647, 1),
      kind: e['kind'] as ExpectedInput['kind'],
      dueAt: instant(e['dueAt']),
      dueLocalDate: frozenDate(e['dueLocalDate']),
      amountMinor: minor(e['amountMinor'], true).toString(),
    };
    if (
      Math.abs(
        Date.parse(result.dueLocalDate) - Date.parse(result.dueAt.slice(0, 10)),
      ) > 86400000 ||
      result.dueLocalDate > deadline
    )
      throw new PlatformFailure('invalid');
    return result;
  });
  if (new Set(expected.map((e) => e.id)).size !== expected.length)
    throw new PlatformFailure('invalid');
  return {
    formulaVersion: 1,
    goalRevision: integer(b['goalRevision'], 2147483647, 1),
    status: b['status'] as GoalStatus,
    targetMinor: minor(b['targetMinor'], true).toString(),
    currency: currency(b['currency']),
    startDate,
    deadline,
    retainedEarningsBasisPoints: integer(
      b['retainedEarningsBasisPoints'],
      10000,
    ),
    asOf,
    calculationDate,
    timezone,
    identityProfileRevision: integer(
      b['identityProfileRevision'],
      2147483647,
      1,
    ),
    work,
    finance,
    expected,
  };
}
export function ceilMoney(
  numerator: bigint,
  denominator: bigint,
): string | null {
  if (denominator <= 0n) return null;
  return minor(
    ((numerator + denominator - 1n) / denominator).toString(),
  ).toString();
}
export function progress(
  targetMinor: string,
  balanceMinor: string,
  allocated = true,
) {
  const creditedMinor = allocated
    ? minor(balanceMinor) > 0n
      ? minor(balanceMinor).toString()
      : '0'
    : '0';
  const deficit = minor(targetMinor) - minor(creditedMinor);
  return {
    creditedMinor,
    remainingMinor: deficit > 0n ? deficit.toString() : '0',
  };
}
export function calculate(raw: CalculationInput) {
  const input = calculationInput(raw),
    today = input.calculationDate,
    from = today > input.startDate ? today : input.startDate;
  const time = calendar(
    from,
    input.deadline,
    input.work
      ? {
          minutesPerDay: input.work.minutesPerDay,
          weekdays: input.work.weekdays,
        }
      : null,
  );
  const totals = {
    'predicted-income': '0',
    receivable: '0',
    'scheduled-debit': '0',
    payable: '0',
  };
  for (const e of input.expected)
    totals[e.kind] = add(totals[e.kind], e.amountMinor);
  const incomingMinor = add(totals['predicted-income'], totals.receivable),
    outgoingMinor = add(totals['scheduled-debit'], totals.payable),
    netMinor = add(incomingMinor, (-minor(outgoingMinor)).toString());
  const plannedBalanceMinor = add(input.finance.balanceMinor, netMinor);
  function scenario(name: 'CONSERVATIVE' | 'PLANNED', balance: string) {
    const funding = progress(
      input.targetMinor,
      balance,
      input.status !== 'CANCELLED',
    );
    const fundingShortfallMinor =
      input.status !== 'CANCELLED' && minor(balance) < 0n
        ? (-minor(balance)).toString()
        : '0';
    const requiredRetainedMinor = add(
        funding.remainingMinor,
        fundingShortfallMinor,
      ),
      required = minor(requiredRetainedMinor);
    const requiredGrossMinor =
      required === 0n
        ? '0'
        : ceilMoney(
            required * 10000n,
            BigInt(input.retainedEarningsBasisPoints),
          );
    const rateReason =
      input.status !== 'ACTIVE'
        ? 'inactive-goal'
        : time.days === 0
          ? 'expired'
          : requiredGrossMinor === null
            ? 'zero-retention'
            : null;
    const gross =
      requiredGrossMinor === null ? null : minor(requiredGrossMinor);
    const rates =
      rateReason || gross === null
        ? {
            calendarDayMinor: null,
            weekMinor: null,
            monthMinor: null,
            workdayMinor: null,
            hourMinor: null,
          }
        : {
            calendarDayMinor: ceilMoney(gross, BigInt(time.days)),
            weekMinor: ceilMoney(7n * gross, BigInt(time.days)),
            monthMinor: ceilMoney(
              gross * BigInt(time.monthExposure.denominator),
              BigInt(time.monthExposure.numerator),
            ),
            workdayMinor:
              time.workdays === null
                ? null
                : ceilMoney(gross, BigInt(time.workdays)),
            hourMinor:
              time.minutes === null
                ? null
                : ceilMoney(60n * gross, BigInt(time.minutes)),
          };
    const comparisonReason =
      rateReason ??
      (!input.work
        ? 'missing-work'
        : input.work.currency !== input.currency
          ? 'currency-mismatch'
          : input.work.capacityMinor === null
            ? input.work.capacityReason
            : name === 'PLANNED' && minor(incomingMinor) > 0n
              ? 'possible-planned-income-overlap'
              : null);
    const capacityComparison =
      comparisonReason || gross === null
        ? 'UNKNOWN'
        : gross <= minor(input.work!.capacityMinor!)
          ? 'WITHIN_DECLARED_CAPACITY'
          : 'ABOVE_DECLARED_CAPACITY';
    return {
      scenario: name,
      ...funding,
      fundingShortfallMinor,
      requiredRetainedMinor,
      requiredGrossMinor,
      rates,
      rateReason,
      workRateReason:
        input.work === null
          ? 'missing-work'
          : time.minutes === 0
            ? 'zero-work-time'
            : null,
      capacityComparison,
      comparisonReason,
    };
  }
  return {
    formulaVersion: 1,
    asOf: input.asOf,
    calculationDate: input.calculationDate,
    timezone: input.timezone,
    currency: input.currency,
    status: input.status,
    from,
    through: input.deadline,
    ...time,
    workRevision: input.work?.revision ?? null,
    identityProfileRevision: input.identityProfileRevision,
    goalRevision: input.goalRevision,
    financeCursor: input.finance.cursor,
    accountId: input.finance.accountId,
    accountCursor: input.finance.accountCursor,
    accountRevision: input.finance.accountRevision,
    expectedInputs: input.expected.map((e) => ({
      id: e.id,
      revision: e.revision,
    })),
    declaredCapacityMinor: input.work?.capacityMinor ?? null,
    declaredCapacityCurrency: input.work?.currency ?? null,
    declaredMonthlyMinor: input.work?.monthlyDeclaredMinor ?? null,
    projectCount: input.work?.projectCount ?? null,
    retainedEarningsBasisPoints: input.retainedEarningsBasisPoints,
    conservative: scenario('CONSERVATIVE', input.finance.balanceMinor),
    planned: {
      ...scenario('PLANNED', plannedBalanceMinor),
      projectedBalanceMinor: plannedBalanceMinor,
      predictedIncomeMinor: totals['predicted-income'],
      receivableMinor: totals.receivable,
      scheduledDebitMinor: totals['scheduled-debit'],
      payableMinor: totals.payable,
      incomingMinor,
      outgoingMinor,
      netMinor,
    },
    assumptions: [
      'exclusive-account-attribution-not-escrow',
      'whole-civil-planning-days-including-today',
      'gross-rates-with-user-declared-retention',
      'planned-full-realization-including-overdue',
      'pinned-profile-before-finance-snapshot',
      'work-capacity-not-guaranteed-or-exclusive',
    ],
  };
}
