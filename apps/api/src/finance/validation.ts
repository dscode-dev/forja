import { BadRequestException } from '@nestjs/common';
import { object, text, uuidPattern } from '../identity/validation';
export { object };
export function id(value: unknown): string {
  return text(value, 36, uuidPattern).toLowerCase();
}
export function note(value: unknown): string {
  return text(value, 500).normalize('NFC');
}
export function instant(value: unknown, actual = false): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value ||
    Date.parse(value) < 0 ||
    (actual && Date.parse(value) > Date.now())
  )
    throw new BadRequestException();
  return value;
}
export function page(value: unknown): number {
  const n = value === undefined ? 100 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new BadRequestException();
  return n;
}
export function cursor(value: unknown): number {
  const n = value === undefined ? 0 : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new BadRequestException();
  return n;
}

export function idempotency(value: unknown): string {
  const key = id(value);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      key,
    )
  )
    throw new BadRequestException();
  return key;
}
