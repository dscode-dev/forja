import { Injectable } from '@nestjs/common';
import { Transaction } from './database';
import { PlatformFailure } from './failure';
// Actual domain consumers register their own purge; Identity coordinates only after denial/drain.
@Injectable()
export class PrivacyErasure {
  private readonly consumers = new Map<
    'finance' | 'planning' | 'work',
    (tx: Transaction, owner: string) => Promise<void>
  >();
  register(
    name: 'finance' | 'planning' | 'work',
    purge: (tx: Transaction, owner: string) => Promise<void>,
  ): void {
    if (this.consumers.has(name)) throw new PlatformFailure('conflict');
    this.consumers.set(name, purge);
  }
  async erase(tx: Transaction, owner: string): Promise<void> {
    await tx.query("SELECT set_config('forja.erase_user',$1,true)", [owner]);
    for (const name of ['planning', 'work', 'finance'] as const)
      await this.consumers.get(name)?.(tx, owner);
  }
}
