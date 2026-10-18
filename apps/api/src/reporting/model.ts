import { date } from '../work/model';
import { localDates } from '../planning/goals/model';
import { minor } from '../finance/money';
import { id } from '../finance/validation';
import { object } from '../identity/validation';
import { PlatformFailure } from '../platform/failure';
export type ReportType = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
export interface ReportCommand {
  accountId: string;
  type: ReportType;
  from: string;
  through: string;
}
export function command(raw: unknown): ReportCommand {
  const b = object(raw, ['accountId', 'type', 'from', 'through']);
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM'].includes(String(b['type'])))
    throw new PlatformFailure('invalid');
  const from = date(b['from']),
    through = date(b['through']);
  if (
    from > through ||
    (Date.parse(through) - Date.parse(from)) / 86400000 >= 366 ||
    (b['type'] !== 'CUSTOM' && from !== through)
  )
    throw new PlatformFailure('invalid');
  return {
    accountId: id(b['accountId']),
    type: b['type'] as ReportType,
    from,
    through,
  };
}
export function shift(day: string, count: number) {
  return date(
    new Date(Date.parse(day) + count * 86400000).toISOString().slice(0, 10),
  );
}
export function midnight(day: string, timezone: string): string {
  date(day);
  const label = localDates(timezone);
  let lo = Date.parse(day) - 2 * 86400000,
    hi = Date.parse(day) + 2 * 86400000;
  // First instant with local civil date >= requested label; handles skipped midnight/date.
  while (lo < hi) {
    const m = Math.floor((lo + hi) / 2);
    if (label(new Date(m).toISOString()) < day) lo = m + 1;
    else hi = m;
  }
  return new Date(lo).toISOString();
}
export function periods(c: ReportCommand, timezone: string, asOf: string) {
  let from = c.from,
    through = c.through;
  if (c.type === 'WEEKLY') {
    from = shift(from, -((new Date(from).getUTCDay() + 6) % 7));
    through = shift(from, 6);
  }
  if (c.type === 'MONTHLY') {
    from = from.slice(0, 7) + '-01';
    const d = new Date(from);
    d.setUTCMonth(d.getUTCMonth() + 1);
    through = shift(d.toISOString().slice(0, 10), -1);
  }
  const days = (Date.parse(through) - Date.parse(from)) / 86400000 + 1;
  let previousFrom = shift(from, -days);
  const previousThrough = shift(from, -1);
  if (c.type === 'MONTHLY') previousFrom = previousThrough.slice(0, 7) + '-01';
  const make = (f: string, t: string) => ({
    from: f,
    through: t,
    start: midnight(f, timezone),
    end: midnight(shift(t, 1), timezone),
  });
  const current = make(from, through),
    previous = make(previousFrom, previousThrough);
  if (current.start > asOf) throw new PlatformFailure('invalid');
  return {
    type: c.type,
    timezone,
    current,
    previous,
    partial: current.end > asOf,
    comparison: 'full-previous-civil-period' as const,
  };
}
export type Period = ReturnType<typeof periods>['current'];
export interface Metrics {
  incomeMinor: string;
  expenseMinor: string;
  netMinor: string;
  openingMinor: string;
  closingMinor: string;
  baselineChangeMinor: string;
}
export function comparison(current: string, previous: string) {
  const delta = minor((minor(current) - minor(previous)).toString()).toString(),
    base = minor(previous);
  if (base === 0n)
    return {
      deltaMinor: delta,
      percentageBasisPoints: null,
      reason: 'ZERO_BASELINE' as const,
    };
  const n = BigInt(delta) * 10000n,
    den = base < 0n ? -base : base,
    abs = n < 0n ? -n : n;
  const rounded = ((abs * 2n + den) / (2n * den)) * (n < 0n ? -1n : 1n);
  return {
    deltaMinor: delta,
    percentageBasisPoints: rounded.toString(),
    reason: 'ABSOLUTE_PREVIOUS_DENOMINATOR' as const,
  };
}
