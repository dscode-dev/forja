import { createHash } from 'node:crypto';
import { PlatformFailure } from '../failure';
import { ProtectedKey, WrapBinding } from './contracts';
export function uuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new PlatformFailure('invalid');
  return value;
}
export function token(value: string): string {
  if (!/^[a-z][a-z0-9._:-]{0,127}$/.test(value))
    throw new PlatformFailure('invalid');
  return value;
}
export function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new PlatformFailure('invalid');
  return value;
}
export function base64(value: unknown, length?: number): Buffer {
  if (
    typeof value !== 'string' ||
    value.length > 1400000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new PlatformFailure('invalid');
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.toString('base64') !== value ||
    (length !== undefined && decoded.length !== length)
  )
    throw new PlatformFailure('invalid');
  return decoded;
}
export function json(value: readonly unknown[]): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}
export function wrapArray(
  binding: WrapBinding,
  ref: string,
  version: number,
): readonly unknown[] {
  return [
    'forja-wrap',
    1,
    token(binding.environment),
    uuid(binding.userId),
    uuid(binding.dekId),
    positive(binding.version),
    'forja.user-data',
    token(ref),
    positive(version),
  ];
}
export function fingerprint(record: ProtectedKey): string {
  return createHash('sha256')
    .update(
      json([
        record.format,
        token(record.provider),
        wrapArray(record.binding, record.kekRef, record.kekVersion),
        record.wrapped.toString('base64'),
      ]),
    )
    .digest('hex');
}
export function digest(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new PlatformFailure('invalid');
  return value;
}
