import { Currency, currency, minor, add } from '../finance/money';
import { object, text } from '../identity/validation';
import { PlatformFailure } from '../platform/failure';
export const kinds = [
  'FIXED_MONTHLY',
  'HOURLY',
  'DAILY',
  'PER_PROJECT',
  'VARIABLE',
] as const;
export type Kind = (typeof kinds)[number];
export const workStatuses = [
  'employed',
  'self-employed',
  'unemployed',
  'student',
  'other',
] as const;
export const workModels = [
  'employment',
  'independent',
  'business',
  'mixed',
  'none',
] as const;
export interface WorkProfile {
  workStatus: (typeof workStatuses)[number];
  occupation: string | null;
  workModel: (typeof workModels)[number];
  earningModel: Kind | 'MIXED';
  currency: Currency;
  components: { kind: Kind; amountMinor: string | null }[];
  availability: {
    availableMinutesPerDay: number;
    preferredWeekdays: number[];
    maximumMinutesPerWeek: number;
    committedMinutesPerWeek: number | null;
  };
  skills: string[];
  desiredDirection: string | null;
  careerTarget: string | null;
  notes: string | null;
}
export function integer(value: unknown, maximum: number, minimum = 0): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new PlatformFailure('invalid');
  return value;
}
export function queryInteger(
  value: unknown,
  maximum: number,
  minimum = 0,
): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,9})$/u.test(value))
    throw new PlatformFailure('invalid');
  return integer(Number(value), maximum, minimum);
}
function selection<T extends string>(value: unknown, options: readonly T[]): T {
  if (
    typeof value !== 'string' ||
    !(options as readonly string[]).includes(value)
  )
    throw new PlatformFailure('invalid');
  return value as T;
}
function privateText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  const result = text(value, maximum).normalize('NFC').trim();
  return text(result, maximum);
}
export function profile(value: unknown): WorkProfile {
  const b = object(value, [
    'workStatus',
    'occupation',
    'workModel',
    'earningModel',
    'currency',
    'components',
    'availability',
    'skills',
    'desiredDirection',
    'careerTarget',
    'notes',
  ]);
  const earningModel = selection(b['earningModel'], [
    ...kinds,
    'MIXED',
  ]) as WorkProfile['earningModel'];
  if (
    !Array.isArray(b['components']) ||
    !b['components'].length ||
    b['components'].length > 4
  )
    throw new PlatformFailure('invalid');
  const components = b['components']
    .map((raw: unknown) => {
      const c = object(raw, ['kind', 'amountMinor']);
      const kind = selection(c['kind'], kinds) as Kind;
      const amountMinor =
        c['amountMinor'] === null && kind === 'VARIABLE'
          ? null
          : minor(c['amountMinor']).toString();
      if (amountMinor !== null && minor(amountMinor) < 0n)
        throw new PlatformFailure('invalid');
      return { kind, amountMinor };
    })
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  if (
    new Set(components.map((c) => c.kind)).size !== components.length ||
    (components.some((c) => c.kind === 'HOURLY') &&
      components.some((c) => c.kind === 'DAILY')) ||
    (earningModel === 'MIXED'
      ? components.length < 2
      : components.length !== 1 || components[0]!.kind !== earningModel)
  )
    throw new PlatformFailure('invalid');
  const a = object(b['availability'], [
    'availableMinutesPerDay',
    'preferredWeekdays',
    'maximumMinutesPerWeek',
    'committedMinutesPerWeek',
  ]);
  if (
    !Array.isArray(a['preferredWeekdays']) ||
    a['preferredWeekdays'].length > 7
  )
    throw new PlatformFailure('invalid');
  const preferredWeekdays = a['preferredWeekdays']
    .map((d: unknown) => integer(d, 7, 1))
    .sort((x, y) => x - y);
  const availability = {
    availableMinutesPerDay: integer(a['availableMinutesPerDay'], 1440),
    preferredWeekdays,
    maximumMinutesPerWeek: integer(a['maximumMinutesPerWeek'], 10080),
    committedMinutesPerWeek:
      a['committedMinutesPerWeek'] === null
        ? null
        : integer(a['committedMinutesPerWeek'], 10080),
  };
  if (
    new Set(preferredWeekdays).size !== preferredWeekdays.length ||
    (!preferredWeekdays.length && availability.availableMinutesPerDay !== 0) ||
    availability.availableMinutesPerDay * preferredWeekdays.length +
      (availability.committedMinutesPerWeek ?? 0) >
      availability.maximumMinutesPerWeek
  )
    throw new PlatformFailure('invalid');
  if (!Array.isArray(b['skills']) || b['skills'].length > 20)
    throw new PlatformFailure('invalid');
  const skills = b['skills'].map((s: unknown) => {
    if (s === null) throw new PlatformFailure('invalid');
    return privateText(s, 80)!;
  });
  if (new Set(skills).size !== skills.length)
    throw new PlatformFailure('invalid');
  return {
    workStatus: selection(b['workStatus'], workStatuses),
    occupation: privateText(b['occupation'], 120),
    workModel: selection(b['workModel'], workModels),
    earningModel,
    currency: currency(b['currency']),
    components,
    availability,
    skills,
    desiredDirection: privateText(b['desiredDirection'], 240),
    careerTarget: privateText(b['careerTarget'], 240),
    notes: privateText(b['notes'], 500),
  };
}
export function date(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value) ||
    value < '1970-01-01' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new PlatformFailure('invalid');
  return value;
}
export interface Horizon {
  from: string;
  through: string;
  projectCount?: number;
}
export function capacity(input: WorkProfile, horizon: Horizon) {
  const p = profile(input),
    from = date(horizon.from),
    through = date(horizon.through);
  const count = (Date.parse(through) - Date.parse(from)) / 86400000 + 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 366)
    throw new PlatformFailure('invalid');
  if (horizon.projectCount !== undefined) {
    integer(horizon.projectCount, 1000);
    if (!p.components.some((c) => c.kind === 'PER_PROJECT'))
      throw new PlatformFailure('invalid');
  }
  let eligibleDays = 0;
  const months = new Map<string, { included: bigint; days: bigint }>();
  for (let index = 0; index < count; index++) {
    const d = new Date(Date.parse(from) + index * 86400000);
    if (
      p.availability.preferredWeekdays.includes(d.getUTCDay() || 7) &&
      p.availability.availableMinutesPerDay > 0
    )
      eligibleDays++;
    const key = d.toISOString().slice(0, 7);
    const m = months.get(key) ?? {
      included: 0n,
      days: BigInt(
        new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
        ).getUTCDate(),
      ),
    };
    m.included++;
    months.set(key, m);
  }
  const components = p.components.map((c) => {
    let estimateMinor: string | null = null;
    if (c.amountMinor !== null) {
      const rate = minor(c.amountMinor);
      let numerator = 0n,
        denominator = 1n;
      if (c.kind === 'HOURLY') {
        numerator =
          rate *
          BigInt(eligibleDays) *
          BigInt(p.availability.availableMinutesPerDay);
        denominator = 60n;
      } else if (c.kind === 'DAILY') numerator = rate * BigInt(eligibleDays);
      else if (c.kind === 'PER_PROJECT') {
        if (horizon.projectCount !== undefined)
          numerator = rate * BigInt(horizon.projectCount);
      } else
        for (const month of months.values()) {
          numerator =
            numerator * month.days + rate * month.included * denominator;
          denominator *= month.days;
        }
      if (c.kind !== 'PER_PROJECT' || horizon.projectCount !== undefined)
        estimateMinor = minor((numerator / denominator).toString()).toString();
    }
    return { ...c, estimateMinor };
  });
  const knownSubtotalMinor = components.reduce(
    (sum, c) => add(sum, c.estimateMinor ?? '0'),
    '0',
  );
  return {
    formulaVersion: 1,
    timezone: 'UTC',
    currency: p.currency,
    from,
    through,
    availableMinutesPerWeek:
      p.availability.availableMinutesPerDay *
      p.availability.preferredWeekdays.length,
    eligibleDays,
    projectCount: horizon.projectCount ?? null,
    availability: p.availability,
    components,
    knownSubtotalMinor,
    totalMinor: components.every((c) => c.estimateMinor !== null)
      ? knownSubtotalMinor
      : null,
    assumptions: [
      'user-declared-unverified',
      'gross-before-costs-taxes',
      'profile-fixed-for-horizon',
      'utc-civil-days',
      'per-component-floor',
      'no-financial-effects',
    ],
  };
}
