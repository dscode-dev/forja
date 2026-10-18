import { test } from 'node:test';
import assert from 'node:assert/strict';
import { command, periods, midnight, comparison } from '../src/reporting/model';
import { ReadBudget } from '../src/platform/read-budget';
const base = {
  accountId: '68ca0451-5e40-4b65-b0c9-b4430be02c6d',
  type: 'DAILY',
  from: '2026-03-08',
  through: '2026-03-08',
};
test('report periods freeze timezone/DST, ISO weeks, unequal calendar months and bounded custom civil ranges', () => {
  const daily = periods(
    command(base),
    'America/New_York',
    '2026-10-01T00:00:00.000Z',
  );
  assert.equal(daily.current.start, '2026-03-08T05:00:00.000Z');
  assert.equal(daily.current.end, '2026-03-09T04:00:00.000Z');
  const fall = periods(
    command({ ...base, from: '2026-11-01', through: '2026-11-01' }),
    'America/New_York',
    '2026-12-01T00:00:00.000Z',
  );
  assert.equal(
    Date.parse(fall.current.end) - Date.parse(fall.current.start),
    25 * 3600000,
  );
  const week = periods(
    command({ ...base, type: 'WEEKLY' }),
    'America/Sao_Paulo',
    '2026-10-01T00:00:00.000Z',
  );
  assert.equal(week.current.from, '2026-03-02');
  assert.equal(week.current.through, '2026-03-08');
  const month = periods(
    command({ ...base, type: 'MONTHLY' }),
    'UTC',
    '2026-10-01T00:00:00.000Z',
  );
  assert.equal(month.previous.from, '2026-02-01');
  assert.equal(month.previous.through, '2026-02-28');
  assert.equal(month.current.through, '2026-03-31');
  assert.equal(
    midnight('2018-11-04', 'America/Sao_Paulo'),
    '2018-11-04T03:00:00.000Z',
  );
  assert.equal(
    midnight('2011-12-30', 'Pacific/Apia'),
    midnight('2011-12-31', 'Pacific/Apia'),
  );
  assert.throws(() =>
    command({
      ...base,
      type: 'CUSTOM',
      from: '2025-01-01',
      through: '2026-01-02',
    }),
  );
  assert.throws(() => command({ ...base, from: '2026-02-30' }));
  assert.throws(() =>
    periods(command(base), 'UTC', '2025-01-01T00:00:00.000Z'),
  );
  const custom = periods(
    command({
      ...base,
      type: 'CUSTOM',
      from: '2026-01-02',
      through: '2026-01-04',
    }),
    'UTC',
    '2026-01-03T12:00:00.000Z',
  );
  assert.equal(custom.previous.from, '2025-12-30');
  assert.equal(custom.previous.through, '2026-01-01');
  assert.equal(custom.partial, true);
});
test('report comparisons use exact bounded money, explicit zero baseline and signed half-away rounding', () => {
  assert.deepEqual(comparison('100', '0'), {
    deltaMinor: '100',
    percentageBasisPoints: null,
    reason: 'ZERO_BASELINE',
  });
  assert.equal(comparison('200', '100').percentageBasisPoints, '10000');
  assert.equal(comparison('-50', '-100').percentageBasisPoints, '5000');
  assert.equal(comparison('1', '3').percentageBasisPoints, '-6667');
  assert.equal(comparison('19999', '20000').percentageBasisPoints, '-1');
  assert.throws(() => comparison('999999999999999999', '-1'));
  const b = new ReadBudget();
  b.take(999);
  b.take(1);
  assert.throws(() => b.take(1));
});
