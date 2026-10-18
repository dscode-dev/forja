import { PlatformFailure } from './failure';
export class ReadBudget {
  used = 0;
  take(n: number) {
    if (!Number.isSafeInteger(n) || n < 0)
      throw new PlatformFailure('integrity');
    this.used += n;
    if (this.used > 1000) throw new PlatformFailure('bounded_period');
  }
  remaining() {
    return Math.max(0, 1000 - this.used);
  }
}
