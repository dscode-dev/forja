import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculate,
  CalculationInput,
  calendar,
  localDate,
  goal,
  snapshot,
} from '../src/planning/goals/model';
const input: CalculationInput = {
  formulaVersion: 1,
  goalRevision: 1,
  status: 'ACTIVE',
  targetMinor: '1000000',
  currency: 'BRL',
  startDate: '2026-10-05',
  deadline: '2026-10-11',
  retainedEarningsBasisPoints: 10000,
  asOf: '2026-10-05T10:00:00.000Z',
  calculationDate: '2026-10-05',
  timezone: 'America/Recife',
  identityProfileRevision: 1,
  work: {
    revision: 1,
    recordedAt: '2026-10-01T00:00:00.000Z',
    currency: 'BRL',
    minutesPerDay: 240,
    weekdays: [1, 2, 3, 4, 5],
    capacityMinor: '200000',
    capacityReason: 'known',
    monthlyDeclaredMinor: null,
    projectCount: null,
  },
  finance: {
    cursor: 1,
    accountId: '00000000-0000-4000-8000-000000000001',
    accountCursor: 1,
    accountRevision: 1,
    balanceMinor: '200000',
  },
  expected: [],
};
test('exact settled deficit, required rates, declared capacity and separate planned categories', () => {
  const c = calculate(input);
  assert.equal(c.conservative.remainingMinor, '800000');
  assert.equal(c.conservative.requiredGrossMinor, '800000');
  assert.deepEqual(c.conservative.rates, {
    calendarDayMinor: '114286',
    weekMinor: '800000',
    monthMinor: '3542858',
    workdayMinor: '160000',
    hourMinor: '40000',
  });
  assert.equal(c.conservative.capacityComparison, 'ABOVE_DECLARED_CAPACITY');
  const planned = calculate({
    ...input,
    expected: [
      {
        id: '00000000-0000-4000-8000-000000000002',
        revision: 1,
        kind: 'receivable',
        dueAt: '2026-10-06T00:00:00.000Z',
        dueLocalDate: '2026-10-05',
        amountMinor: '300000',
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        revision: 1,
        kind: 'scheduled-debit',
        dueAt: '2026-10-07T00:00:00.000Z',
        dueLocalDate: '2026-10-06',
        amountMinor: '100000',
      },
    ],
  });
  assert.equal(planned.conservative.remainingMinor, '800000');
  assert.equal(planned.planned.remainingMinor, '600000');
  assert.equal(planned.planned.incomingMinor, '300000');
  assert.equal(planned.planned.outgoingMinor, '100000');
  assert.equal(planned.planned.capacityComparison, 'UNKNOWN');
  assert.equal(
    planned.planned.comparisonReason,
    'possible-planned-income-overlap',
  );
  assert.equal(
    calculate({ ...input, retainedEarningsBasisPoints: 8000 }).conservative
      .requiredGrossMinor,
    '1000000',
  );
  assert.equal(
    calculate({
      ...input,
      work: {
        ...input.work!,
        capacityMinor: '1000000',
        monthlyDeclaredMinor: '4428572',
      },
    }).conservative.capacityComparison,
    'WITHIN_DECLARED_CAPACITY',
  );
});
test('timezone/DST, today, expiry, inactive goals and exact Gregorian month exposure', () => {
  assert.equal(
    localDate('1970-01-01T00:00:00.000Z', 'America/Recife'),
    '1969-12-31',
  );
  const frozen = {
    ...input,
    startDate: '2026-10-01',
    asOf: '2026-10-05T02:00:00.000Z',
    calculationDate: '2026-10-04',
  };
  const historical = calculate(frozen),
    changedRules = calculate({ ...frozen, timezone: 'Historical/Zone_Alias' });
  assert.equal(historical.days, 8);
  assert.deepEqual(changedRules.conservative, historical.conservative);
  assert.equal(
    localDate('2026-03-08T04:30:00.000Z', 'America/New_York'),
    '2026-03-07',
  );
  assert.equal(
    localDate('2026-03-08T07:30:00.000Z', 'America/New_York'),
    '2026-03-08',
  );
  assert.equal(
    calendar('2026-03-07', '2026-03-08', {
      minutesPerDay: 240,
      weekdays: [6, 7],
    }).days,
    2,
  );
  assert.deepEqual(calendar('2026-01-31', '2026-02-01', null).monthExposure, {
    numerator: '59',
    denominator: '868',
  });
  assert.deepEqual(calendar('2028-02-01', '2028-02-29', null).monthExposure, {
    numerator: '29',
    denominator: '29',
  });
  assert.deepEqual(calendar('2026-01-01', '2030-12-31', null).monthExposure, {
    numerator: '57660',
    denominator: '961',
  });
  const today = calculate({ ...input, deadline: '2026-10-05' });
  assert.equal(today.days, 1);
  assert.equal(today.conservative.rates.hourMinor, '200000');
  const expired = calculate({
    ...input,
    startDate: '2026-10-01',
    deadline: '2026-10-04',
  });
  assert.equal(expired.days, 0);
  assert.equal(expired.conservative.remainingMinor, '800000');
  assert.equal(expired.conservative.rates.hourMinor, null);
  assert.equal(expired.conservative.rateReason, 'expired');
  for (const status of ['PAUSED', 'COMPLETED', 'CANCELLED'] as const) {
    const v = calculate({ ...input, status });
    assert.equal(v.conservative.rates.weekMinor, null);
    assert.equal(v.conservative.rateReason, 'inactive-goal');
  }
});
test('unknown/zero time, zero retention, negative funds, currency separation and exact monetary bounds', () => {
  for (const work of [
    null,
    { ...input.work!, minutesPerDay: 0, weekdays: [], capacityMinor: '0' },
  ]) {
    const v = calculate({ ...input, work });
    assert.equal(v.conservative.rates.hourMinor, null);
    assert.equal(v.conservative.rates.workdayMinor, null);
    assert.equal(v.conservative.rates.weekMinor, '800000');
  }
  assert.equal(
    calculate({ ...input, retainedEarningsBasisPoints: 0 }).conservative
      .requiredGrossMinor,
    null,
  );
  assert.equal(
    calculate({
      ...input,
      finance: { ...input.finance, balanceMinor: '1000000' },
      retainedEarningsBasisPoints: 0,
    }).conservative.requiredGrossMinor,
    '0',
  );
  assert.equal(
    calculate({ ...input, finance: { ...input.finance, balanceMinor: '-100' } })
      .conservative.creditedMinor,
    '0',
  );
  const negative = calculate({
    ...input,
    finance: { ...input.finance, balanceMinor: '-100' },
  });
  assert.equal(negative.conservative.remainingMinor, '1000000');
  assert.equal(negative.conservative.fundingShortfallMinor, '100');
  assert.equal(negative.conservative.requiredRetainedMinor, '1000100');
  assert.equal(negative.conservative.requiredGrossMinor, '1000100');
  const futureShortfall = calculate({
    ...input,
    expected: [
      {
        id: '00000000-0000-4000-8000-000000000003',
        revision: 1,
        kind: 'scheduled-debit',
        dueAt: '2026-10-06T00:00:00.000Z',
        dueLocalDate: '2026-10-05',
        amountMinor: '1000000',
      },
    ],
  });
  assert.equal(futureShortfall.planned.fundingShortfallMinor, '800000');
  assert.equal(futureShortfall.planned.requiredGrossMinor, '1800000');
  const epoch = calculate({
    ...input,
    expected: [
      {
        id: '00000000-0000-4000-8000-000000000004',
        revision: 1,
        kind: 'receivable',
        dueAt: '1970-01-01T00:00:00.000Z',
        dueLocalDate: '1969-12-31',
        amountMinor: '1',
      },
    ],
  });
  assert.equal(epoch.planned.incomingMinor, '1');
  const mismatch = calculate({
    ...input,
    work: { ...input.work!, currency: 'USD' },
  });
  assert.equal(mismatch.conservative.capacityComparison, 'UNKNOWN');
  assert.equal(mismatch.conservative.comparisonReason, 'currency-mismatch');
  const large = calculate({
    ...input,
    targetMinor: '9007199254740993',
    finance: { ...input.finance, balanceMinor: '0' },
    startDate: '2026-01-01',
    deadline: '2027-12-31',
    work: {
      ...input.work!,
      capacityMinor: null,
      capacityReason: 'work-horizon-bound',
    },
  });
  assert.equal(large.conservative.requiredGrossMinor, '9007199254740993');
  assert.equal(large.conservative.capacityComparison, 'UNKNOWN');
  assert.throws(() =>
    calculate({
      ...input,
      targetMinor: '999999999999999999',
      retainedEarningsBasisPoints: 1,
    }),
  );
  assert.throws(() => calculate({ ...input, targetMinor: '01' }));
  assert.throws(() => calculate({ ...input, timezone: 'invalid:timezone' }));
});
test('strict goal model, positive target, retained-share assumptions and encrypted lifecycle validation', () => {
  const g = {
    title: 'Meta',
    description: null,
    targetMinor: '1000000',
    currency: 'BRL',
    startDate: '2026-10-05',
    deadline: '2026-10-11',
    fundingAccountId: input.finance.accountId,
    retainedEarningsBasisPoints: 10000,
  };
  assert.deepEqual(goal(g), g);
  for (const invalid of [
    { ...g, targetMinor: '0' },
    { ...g, targetMinor: 10000 },
    { ...g, targetMinor: '1.01' },
    { ...g, currency: 'XXX' },
    { ...g, deadline: '2026-02-30' },
    { ...g, deadline: '2026-10-01' },
    { ...g, retainedEarningsBasisPoints: -1 },
    { ...g, retainedEarningsBasisPoints: 10001 },
    { ...g, title: '\uFB2C'.repeat(120) },
    { ...g, userId: 'not-owner' },
  ])
    assert.throws(() => goal(invalid));
  assert.throws(() =>
    snapshot({
      goal: g,
      status: 'COMPLETED',
      action: 'completed',
      completion: null,
    }),
  );
  assert.throws(() =>
    snapshot({
      goal: g,
      status: 'COMPLETED',
      action: 'completed',
      completion: { financeCursor: 1, accountRevision: 1, creditedMinor: '1' },
    }),
  );
});
