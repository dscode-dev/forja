import { PlatformFailure } from '../platform/failure';
import { object } from '../identity/validation';
import { integer } from '../work/model';
import { id, instant } from '../finance/validation';
import { currency, minor, Currency } from '../finance/money';
export const definitions = {
  GOAL_TARGET: {
    version: 1,
    category: 'GOAL_PROGRESS',
    title: 'Avançar uma meta',
    description: 'Alcance o objetivo com recursos realizados.',
    xp: 50,
  },
  RESERVE_TARGET: {
    version: 1,
    category: 'RESERVE',
    title: 'Construir minha reserva',
    description: 'Alcance a meta que você escolheu como reserva.',
    xp: 50,
  },
  WORK_PROFILE: {
    version: 1,
    category: 'PLANNING',
    title: 'Reconhecer minhas possibilidades',
    description: 'Confirme seu perfil profissional, no seu ritmo.',
    xp: 20,
  },
} as const;
export type Template = keyof typeof definitions;
export type State = 'ACTIVE' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';
export interface Basis {
  revision: number;
  accountId: string | null;
  accountRevision: number | null;
  financeCursor: number | null;
  currency: Currency | null;
  targetMinor: string | null;
  creditedMinor: string | null;
}
export interface Mission {
  template: Template;
  version: 1;
  state: State;
  fingerprint: string;
  basis: Basis;
  current: Basis;
  completedAt: string | null;
  reconciliation: 'UNCHANGED' | 'CHANGED';
}
export function template(value: unknown): Template {
  if (typeof value !== 'string' || !Object.hasOwn(definitions, value))
    throw new PlatformFailure('invalid');
  return value as Template;
}
export function basis(raw: unknown): Basis {
  const b = object(raw, [
    'revision',
    'accountId',
    'accountRevision',
    'financeCursor',
    'currency',
    'targetMinor',
    'creditedMinor',
  ]);
  const revision = integer(b['revision'], 2147483647);
  if (b['accountId'] === null) {
    for (const key of [
      'accountRevision',
      'financeCursor',
      'currency',
      'targetMinor',
      'creditedMinor',
    ])
      if (b[key] !== null) throw new PlatformFailure('invalid');
    return {
      revision,
      accountId: null,
      accountRevision: null,
      financeCursor: null,
      currency: null,
      targetMinor: null,
      creditedMinor: null,
    };
  }
  return {
    revision,
    accountId: id(b['accountId']),
    accountRevision: integer(b['accountRevision'], 2147483647, 1),
    financeCursor: integer(b['financeCursor'], Number.MAX_SAFE_INTEGER, 1),
    currency: currency(b['currency']),
    targetMinor: minor(b['targetMinor'], true).toString(),
    creditedMinor: minor(b['creditedMinor']).toString(),
  };
}
export function mission(raw: unknown): Mission {
  const b = object(raw, [
    'template',
    'version',
    'state',
    'fingerprint',
    'basis',
    'current',
    'completedAt',
    'reconciliation',
  ]);
  const t = template(b['template']);
  if (
    b['version'] !== 1 ||
    !['ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED'].includes(
      b['state'] as string,
    ) ||
    !['UNCHANGED', 'CHANGED'].includes(b['reconciliation'] as string) ||
    typeof b['fingerprint'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(b['fingerprint'])
  )
    throw new PlatformFailure('invalid');
  const initial = basis(b['basis']),
    current = basis(b['current']);
  if (
    (t === 'WORK_PROFILE') !== (initial.accountId === null) ||
    (current.accountId === null) !== (initial.accountId === null)
  )
    throw new PlatformFailure('invalid');
  const completedAt =
    b['completedAt'] === null ? null : instant(b['completedAt']);
  if (
    (b['state'] === 'COMPLETED') !== (completedAt !== null) ||
    (b['reconciliation'] === 'CHANGED' && completedAt === null)
  )
    throw new PlatformFailure('invalid');
  return {
    template: t,
    version: 1,
    state: b['state'] as State,
    fingerprint: b['fingerprint'],
    basis: initial,
    current,
    completedAt,
    reconciliation: b['reconciliation'] as Mission['reconciliation'],
  };
}
export function progression(xp: number) {
  integer(xp, Number.MAX_SAFE_INTEGER - 100);
  const level = 1 + Math.floor(xp / 100),
    nextLevelXp = 100 * level;
  return {
    curveVersion: 1,
    xp,
    level,
    nextLevelXp,
    xpToNextLevel: nextLevelXp - xp,
  };
}
export interface Award {
  xp: number;
  totalXp: number;
  template: Template;
  curveVersion: 1;
}
export function award(raw: unknown): Award {
  const b = object(raw, ['xp', 'totalXp', 'template', 'curveVersion']);
  const t = template(b['template']);
  if (b['curveVersion'] !== 1 || b['xp'] !== definitions[t].xp)
    throw new PlatformFailure('invalid');
  const totalXp = integer(
    b['totalXp'],
    Number.MAX_SAFE_INTEGER - 100,
    definitions[t].xp,
  );
  return { xp: definitions[t].xp, totalXp, template: t, curveVersion: 1 };
}
