import { PlatformFailure } from '../platform/failure';
export const currencyDigits = {
  BRL: 2,
  USD: 2,
  EUR: 2,
  JPY: 0,
  KWD: 3,
} as const;
export type Currency = keyof typeof currencyDigits;
export const moneyLimit = 999999999999999999n;
export function currency(value: unknown): Currency {
  if (typeof value !== 'string' || !Object.hasOwn(currencyDigits, value))
    throw new PlatformFailure('invalid');
  return value as Currency;
}
export function minor(value: unknown, positive = false): bigint {
  if (
    typeof value !== 'string' ||
    !/^-?(0|[1-9][0-9]{0,17})$/u.test(value) ||
    value === '-0'
  )
    throw new PlatformFailure('invalid');
  const n = BigInt(value);
  if (n < -moneyLimit || n > moneyLimit || (positive && n <= 0n))
    throw new PlatformFailure('invalid');
  return n;
}
export function add(a: string, b: string): string {
  return minor((minor(a) + minor(b)).toString()).toString();
}
