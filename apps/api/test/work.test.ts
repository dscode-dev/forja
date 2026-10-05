import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacity, profile, WorkProfile } from '../src/work/model';
function input(kind = 'HOURLY', amountMinor: string | null = '10000') {
  return {
    workStatus: 'self-employed',
    occupation: null,
    workModel: 'independent',
    earningModel: kind,
    currency: 'BRL',
    components: [{ kind, amountMinor }],
    availability: {
      availableMinutesPerDay: 240,
      preferredWeekdays: [1, 2, 3, 4, 5],
      maximumMinutesPerWeek: 1200,
      committedMinutesPerWeek: null,
    },
    skills: [],
    desiredDirection: null,
    careerTarget: null,
    notes: null,
  };
}
const week = { from: '2026-10-05', through: '2026-10-11' };
test('earning rules cover every model, explicit mixed composition and unknown estimates', () => {
  assert.equal(capacity(profile(input()), week).totalMinor, '200000');
  assert.equal(capacity(profile(input('DAILY')), week).totalMinor, '50000');
  assert.equal(
    capacity(profile(input('FIXED_MONTHLY', '310000')), {
      from: '2026-10-01',
      through: '2026-10-31',
    }).totalMinor,
    '310000',
  );
  assert.equal(
    capacity(profile(input('VARIABLE', '310000')), week).totalMinor,
    '70000',
  );
  assert.equal(
    capacity(profile(input('VARIABLE', null)), week).totalMinor,
    null,
  );
  assert.equal(capacity(profile(input('PER_PROJECT')), week).totalMinor, null);
  assert.equal(
    capacity(profile(input('PER_PROJECT')), { ...week, projectCount: 3 })
      .totalMinor,
    '30000',
  );
  const mixed = {
    ...input(),
    earningModel: 'MIXED',
    components: [
      { kind: 'HOURLY', amountMinor: '10000' },
      { kind: 'FIXED_MONTHLY', amountMinor: '310000' },
    ],
  };
  assert.equal(capacity(profile(mixed), week).totalMinor, '270000');
  const incomplete = profile({
    ...mixed,
    components: [...mixed.components, { kind: 'VARIABLE', amountMinor: null }],
  });
  assert.equal(capacity(incomplete, week).knownSubtotalMinor, '270000');
  assert.equal(capacity(incomplete, week).totalMinor, null);
  assert.equal(
    capacity(profile(input('PER_PROJECT')), { ...week, projectCount: 0 })
      .totalMinor,
    '0',
  );
});
test('exact money, rational rounding across months, currency precision, zero time and aggregate overflow', () => {
  const exact = profile({
    ...input('DAILY', '9007199254740993'),
    currency: 'JPY',
  });
  assert.equal(capacity(exact, week).totalMinor, '45035996273704965');
  assert.equal(
    capacity(
      profile({
        ...input('HOURLY', '1'),
        currency: 'KWD',
        availability: { ...input().availability, availableMinutesPerDay: 31 },
      }),
      week,
    ).totalMinor,
    '2',
  );
  assert.equal(
    capacity(profile(input('FIXED_MONTHLY', '31')), {
      from: '2026-01-31',
      through: '2026-02-01',
    }).totalMinor,
    '2',
  );
  assert.equal(
    capacity(profile(input('FIXED_MONTHLY', '29')), {
      from: '2028-02-01',
      through: '2028-02-29',
    }).totalMinor,
    '29',
  );
  const zero = profile({
    ...input(),
    availability: {
      availableMinutesPerDay: 0,
      preferredWeekdays: [],
      maximumMinutesPerWeek: 0,
      committedMinutesPerWeek: 0,
    },
  });
  assert.equal(capacity(zero, week).totalMinor, '0');
  assert.throws(() =>
    capacity(profile(input('DAILY', '999999999999999999')), week),
  );
  assert.throws(() =>
    capacity(
      profile({
        ...input(),
        earningModel: 'MIXED',
        components: [
          { kind: 'FIXED_MONTHLY', amountMinor: '999999999999999999' },
          { kind: 'VARIABLE', amountMinor: '1' },
        ],
      }),
      { from: '2026-10-01', through: '2026-10-31' },
    ),
  );
});
test('strict model-specific, text, capacity and horizon validation reject impossible or ambiguous inputs', () => {
  for (const invalid of [
    { ...input(), components: [] },
    {
      ...input(),
      earningModel: 'MIXED',
      components: [
        { kind: 'HOURLY', amountMinor: '1' },
        { kind: 'DAILY', amountMinor: '1' },
      ],
    },
    { ...input(), components: [{ kind: 'DAILY', amountMinor: '1' }] },
    { ...input(), earningModel: 'MIXED' },
    {
      ...input(),
      earningModel: 'MIXED',
      components: [
        { kind: 'HOURLY', amountMinor: '1' },
        { kind: 'HOURLY', amountMinor: '2' },
      ],
    },
    input('HOURLY', null),
    input('HOURLY', '-1'),
    input('HOURLY', '1.01'),
    input('HOURLY', '01'),
    input('HOURLY', 1 as unknown as string),
    { ...input(), currency: 'XXX' },
    { ...input(), occupation: '' },
    { ...input(), occupation: '\uFB2C'.repeat(120) },
    { ...input(), skills: ['same', 'same'] },
    { ...input(), extra: 'forbidden' },
    {
      ...input(),
      availability: { ...input().availability, availableMinutesPerDay: 1441 },
    },
    {
      ...input(),
      availability: { ...input().availability, preferredWeekdays: [1, 1] },
    },
    {
      ...input(),
      availability: { ...input().availability, preferredWeekdays: [] },
    },
    {
      ...input(),
      availability: { ...input().availability, committedMinutesPerWeek: 1 },
    },
    {
      ...input(),
      availability: { ...input().availability, availableMinutesPerDay: 1.5 },
    },
  ])
    assert.throws(() => profile(invalid));
  const normalized = profile({ ...input(), occupation: 'e\u0301' });
  assert.equal(normalized.occupation, 'é');
  assert.deepEqual(profile(normalized), normalized);
  const p: WorkProfile = profile(input());
  for (const h of [
    { from: '2026-02-30', through: '2026-03-01' },
    { from: '2026-10-06', through: '2026-10-05' },
    { from: '2026-01-01', through: '2027-01-02' },
    { ...week, projectCount: 1 },
  ])
    assert.throws(() => capacity(p, h));
});
