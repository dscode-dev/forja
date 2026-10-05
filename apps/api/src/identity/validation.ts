import { BadRequestException } from '@nestjs/common';
export function object(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new BadRequestException();
  return value as Record<string, unknown>;
}
export function text(
  value: unknown,
  maximum: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    (pattern && !pattern.test(value))
  )
    throw new BadRequestException();
  return value;
}
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface ProfileInput {
  displayName: string | null;
  locale: string;
  timezone: string;
  preferredCurrency: string;
  onboardingState: 'pending' | 'complete';
}
export function profileInput(value: unknown): ProfileInput {
  const row = object(value, [
    'displayName',
    'locale',
    'timezone',
    'preferredCurrency',
    'onboardingState',
  ]);
  const name =
    row['displayName'] === null
      ? null
      : text(row['displayName'], 80).normalize('NFC').trim();
  if (name !== null && !name.length) throw new BadRequestException();
  const locale = text(row['locale'], 35, /^[A-Za-z0-9-]+$/);
  const timezone = text(row['timezone'], 64, /^[A-Za-z0-9_+/-]+$/);
  const currency = text(row['preferredCurrency'], 3, /^[A-Z]{3}$/);
  try {
    if (Intl.getCanonicalLocales(locale)[0] !== locale) throw new Error();
    new Intl.DateTimeFormat(locale, { timeZone: timezone });
  } catch {
    throw new BadRequestException();
  }
  if (
    !Intl.supportedValuesOf('currency').includes(currency) ||
    !['pending', 'complete'].includes(String(row['onboardingState']))
  )
    throw new BadRequestException();
  return {
    displayName: name,
    locale,
    timezone,
    preferredCurrency: currency,
    onboardingState: row['onboardingState'] as ProfileInput['onboardingState'],
  };
}
