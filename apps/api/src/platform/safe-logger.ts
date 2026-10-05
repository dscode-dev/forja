import { Injectable, LoggerService } from '@nestjs/common';
export type SafeEvent =
  | 'application.started'
  | 'application.stopped'
  | 'application.failed'
  | 'database.unavailable'
  | 'http.request.failed'
  | 'migration.completed'
  | 'migration.failed'
  | 'identity.authentication'
  | 'data.integrity'
  | 'finance.anchor';
// Identity events carry no principal, profile, provider response or token payload.
export type SafeResult = 'success' | 'unavailable' | 'rejected';
@Injectable()
export class SafeLogger implements LoggerService {
  constructor(
    private readonly sink: (line: string) => void = (line) =>
      process.stdout.write(`${line}\n`),
  ) {}
  event(event: SafeEvent, result: SafeResult): void {
    const events: readonly string[] = [
      'application.started',
      'application.stopped',
      'application.failed',
      'database.unavailable',
      'http.request.failed',
      'migration.completed',
      'migration.failed',
      'identity.authentication',
      'data.integrity',
      'finance.anchor',
    ];
    if (
      !events.includes(event) ||
      !['success', 'unavailable', 'rejected'].includes(result)
    )
      return;
    this.sink(JSON.stringify({ event, result }));
  }
  // Nest/framework messages are arbitrary payloads, therefore intentionally discarded.
  log(..._args: unknown[]): void {}
  error(..._args: unknown[]): void {}
  warn(..._args: unknown[]): void {}
  debug(..._args: unknown[]): void {}
  verbose(..._args: unknown[]): void {}
  fatal(..._args: unknown[]): void {}
}
