export type FailureCode =
  | 'invalid'
  | 'unavailable'
  | 'conflict'
  | 'integrity'
  | 'fenced'
  | 'exhausted'
  | 'commit_unknown';
export class PlatformFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(`Platform operation ${code}`);
  }
}
export function databaseFailure(error: unknown): PlatformFailure {
  if (error instanceof PlatformFailure) return error;
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  return new PlatformFailure(
    ['23505', '23503', '23514', '40001', '40P01'].includes(String(code))
      ? 'conflict'
      : 'unavailable',
  );
}
