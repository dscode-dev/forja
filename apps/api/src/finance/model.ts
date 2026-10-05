import { BadRequestException } from '@nestjs/common';
import { object, id, note, instant } from './validation';
import { minor } from './money';
export type EventKind =
  'opening' | 'income' | 'expense' | 'reversal' | 'replacement' | 'closed';
export interface Account {
  name: string;
  type: 'cash' | 'savings';
  balanceMinor: string;
  openedAt: string;
  lastEvent: string;
  rule: 1;
}
export interface FinancialEvent {
  state: 'posted';
  previousState: 'active' | null;
  nextState: 'active' | 'closed';
  kind: EventKind;
  classification: 'baseline' | 'income' | 'expense';
  deltaMinor: string;
  note: string;
  source: 'user-confirmed';
  previousHash: string;
  commandKind: string;
  commandKey: string;
  actor: string;
  expectedId: string | null;
}
export interface Checkpoint {
  chain: string;
  eventId: string;
  accountHash: string;
  bucketHash: string;
  rule: 1;
}
export interface CommandResult {
  accountId: string | null;
  eventIds: string[];
  expectedId: string | null;
  state: 'active' | 'closed' | 'pending' | 'settled' | 'cancelled' | 'posted';
  seq: number;
}
export interface Receipt {
  fingerprint: string;
  result: CommandResult;
}
export interface Bucket {
  contributionMinor: string;
  incomeMinor: string;
  expenseMinor: string;
  rule: 1;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new BadRequestException();
  return value;
}
export function account(value: unknown): Account {
  const r = object(value, [
    'name',
    'type',
    'balanceMinor',
    'openedAt',
    'lastEvent',
    'rule',
  ]);
  if (!['cash', 'savings'].includes(String(r['type'])) || r['rule'] !== 1)
    throw new BadRequestException();
  return {
    name: note(r['name']),
    type: r['type'] as Account['type'],
    balanceMinor: minor(r['balanceMinor']).toString(),
    openedAt: instant(r['openedAt'], true),
    lastEvent: id(r['lastEvent']),
    rule: 1,
  };
}
export function event(value: unknown): FinancialEvent {
  const r = object(value, [
    'kind',
    'state',
    'previousState',
    'nextState',
    'classification',
    'deltaMinor',
    'note',
    'source',
    'previousHash',
    'commandKind',
    'commandKey',
    'actor',
    'expectedId',
  ]);
  if (
    r['state'] !== 'posted' ||
    ![null, 'active'].includes(r['previousState'] as string | null) ||
    !['active', 'closed'].includes(String(r['nextState'])) ||
    ![
      'opening',
      'income',
      'expense',
      'reversal',
      'replacement',
      'closed',
    ].includes(String(r['kind'])) ||
    !['baseline', 'income', 'expense'].includes(String(r['classification'])) ||
    r['source'] !== 'user-confirmed' ||
    typeof r['commandKind'] !== 'string'
  )
    throw new BadRequestException();
  return {
    state: 'posted',
    previousState: r['previousState'] as 'active' | null,
    nextState: r['nextState'] as 'active' | 'closed',
    kind: r['kind'] as EventKind,
    classification: r['classification'] as FinancialEvent['classification'],
    deltaMinor: minor(r['deltaMinor']).toString(),
    note: note(r['note']),
    source: 'user-confirmed',
    previousHash: digest(r['previousHash']),
    commandKind: r['commandKind'],
    commandKey: id(r['commandKey']),
    actor: id(r['actor']),
    expectedId: r['expectedId'] === null ? null : id(r['expectedId']),
  };
}
export function checkpoint(value: unknown): Checkpoint {
  const r = object(value, [
    'chain',
    'eventId',
    'accountHash',
    'bucketHash',
    'rule',
  ]);
  if (r['rule'] !== 1) throw new BadRequestException();
  return {
    chain: digest(r['chain']),
    eventId: id(r['eventId']),
    accountHash: digest(r['accountHash']),
    bucketHash: digest(r['bucketHash']),
    rule: 1,
  };
}
export function bucket(value: unknown): Bucket {
  const r = object(value, [
    'contributionMinor',
    'incomeMinor',
    'expenseMinor',
    'rule',
  ]);
  if (r['rule'] !== 1) throw new BadRequestException();
  return {
    contributionMinor: minor(r['contributionMinor']).toString(),
    incomeMinor: minor(r['incomeMinor']).toString(),
    expenseMinor: minor(r['expenseMinor']).toString(),
    rule: 1,
  };
}
export function receipt(value: unknown): Receipt {
  const r = object(value, ['fingerprint', 'result']),
    v = object(r['result'], [
      'accountId',
      'eventIds',
      'expectedId',
      'state',
      'seq',
    ]);
  if (
    !Array.isArray(v['eventIds']) ||
    v['eventIds'].length > 2 ||
    !['active', 'closed', 'pending', 'settled', 'cancelled', 'posted'].includes(
      String(v['state']),
    ) ||
    !Number.isSafeInteger(v['seq']) ||
    Number(v['seq']) < 0
  )
    throw new BadRequestException();
  return {
    fingerprint: digest(r['fingerprint']),
    result: {
      accountId: v['accountId'] === null ? null : id(v['accountId']),
      eventIds: v['eventIds'].map(id),
      expectedId: v['expectedId'] === null ? null : id(v['expectedId']),
      state: v['state'] as CommandResult['state'],
      seq: Number(v['seq']),
    },
  };
}
export function stream(value: unknown): { chain: string; rule: 1 } {
  const r = object(value, ['chain', 'rule']);
  if (r['rule'] !== 1) throw new BadRequestException();
  return { chain: digest(r['chain']), rule: 1 };
}
