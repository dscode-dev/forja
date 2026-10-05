import { randomBytes } from 'node:crypto';
import { Database, Transaction, SqlExecutor } from '../database';
import { PlatformFailure } from '../failure';
import {
  Admission,
  KeyIdentity,
  KeyProtectionProvider,
  KeyLifecycleStore,
} from './contracts';
import { PayloadContext, open, seal } from './envelope';
import { fingerprint } from './encoding';
import { UserKeyRepository } from './key-repository';
export interface KeyScope {
  readonly identity: KeyIdentity;
  encrypt(plaintext: Buffer, context: PayloadContext): Promise<string>;
  decrypt(serialized: string, context: PayloadContext): Promise<Buffer>;
  guard(transaction: Transaction): void;
}
export class UserKeyService {
  private closing = false;
  private readonly operations = new Set<Promise<unknown>>();
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new PlatformFailure('fenced'));
    const promise = operation();
    this.operations.add(promise);
    void promise.finally(() => this.operations.delete(promise)).catch(() => {});
    return promise;
  }
  async drain(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.operations]);
  }
  provision(userId: string, identityDigest: string): Promise<KeyIdentity> {
    return this.run(() => this.provisionImpl(userId, identityDigest));
  }
  withKey<T>(
    identity: KeyIdentity,
    identityDigest: string,
    mode: Admission['mode'],
    operation: (scope: KeyScope) => Promise<T>,
    sql?: SqlExecutor,
  ): Promise<T> {
    return this.run(() =>
      this.withKeyImpl(identity, identityDigest, mode, operation, sql),
    );
  }
  rewrap(identity: KeyIdentity, identityDigest: string): Promise<void> {
    return this.run(() => this.rewrapImpl(identity, identityDigest));
  }

  constructor(
    private readonly environment: string,
    private readonly provider: KeyProtectionProvider,
    private readonly lifecycle: KeyLifecycleStore,
    private readonly repository: UserKeyRepository,
    private readonly database: Database,
  ) {}
  private async provisionImpl(
    userId: string,
    identityDigest: string,
  ): Promise<KeyIdentity> {
    const identity = await this.lifecycle.createPending(userId, identityDigest);
    let key: Buffer;
    try {
      key = randomBytes(32);
    } catch {
      throw new PlatformFailure('unavailable');
    }
    try {
      const record = await this.provider.wrap(key, {
        environment: this.environment,
        ...identity,
      });
      await this.repository.insert(record);
      await this.reconcilePending(identity, identityDigest);
      return identity;
    } finally {
      key.fill(0);
    }
  }
  reconcilePending(
    identity: KeyIdentity,
    identityDigest: string,
  ): Promise<void> {
    return this.run(async () => {
      const state = await this.lifecycle.state(identity);
      if (state === 'active' || state === 'decrypt-only') {
        await this.withKey(identity, identityDigest, 'decrypt', async () =>
          this.repository.synchronizeState(
            identity,
            await this.lifecycle.state(identity),
          ),
        );
        return;
      }
      const record = await this.repository.get(identity);
      const fp = fingerprint(record);
      await this.lifecycle.enroll(identity, fp);
      const lease = await this.lifecycle.admitMaintenance(
        identity,
        identityDigest,
        fp,
      );
      let key: Buffer | undefined;
      try {
        key = await this.provider.unwrap(record, record.binding);
        if (key.length !== 32) throw new PlatformFailure('integrity');
      } finally {
        key?.fill(0);
        await this.lifecycle.release(lease);
      }
      await this.lifecycle.activate(identity, fp);
      await this.repository.synchronizeState(identity, 'active');
    });
  }
  private async withKeyImpl<T>(
    identity: KeyIdentity,
    identityDigest: string,
    mode: Admission['mode'],
    operation: (scope: KeyScope) => Promise<T>,
    sql?: SqlExecutor,
  ): Promise<T> {
    const record = await this.repository.get(identity, sql);
    const lease = await this.lifecycle.admit(
      identity,
      identityDigest,
      fingerprint(record),
      mode,
    );
    let key: Buffer | undefined;
    let live = true;
    const plaintexts: Buffer[] = [];
    try {
      key = await this.provider.unwrap(record, {
        environment: this.environment,
        ...identity,
      });
      const contextCheck = async (context: PayloadContext) => {
        if (
          !live ||
          context.environment !== this.environment ||
          context.userId !== identity.userId ||
          context.dekId !== identity.dekId ||
          context.dekVersion !== identity.version
        )
          throw new PlatformFailure('fenced');
        await this.lifecycle.assertAdmission(lease);
        if (!live) throw new PlatformFailure('fenced');
      };
      const scope: KeyScope = {
        identity,
        encrypt: async (plaintext, context) => {
          await contextCheck(context);
          if (mode !== 'encrypt') throw new PlatformFailure('fenced');
          const nonce = await this.lifecycle.reserve(lease);
          if (!live) throw new PlatformFailure('fenced');
          return seal(key!, nonce, plaintext, context);
        },
        decrypt: async (serialized, context) => {
          await contextCheck(context);
          const plaintext = open(key!, serialized, context);
          plaintexts.push(plaintext);
          return plaintext;
        },
        guard: (tx) => {
          if (!live) throw new PlatformFailure('fenced');
          tx.beforeCommit(async () => {
            if (!live) throw new PlatformFailure('fenced');
            await this.lifecycle.assertAdmission(lease);
            if (!live) throw new PlatformFailure('fenced');
          });
        },
      };
      return await operation(scope);
    } catch (error) {
      throw error instanceof PlatformFailure
        ? error
        : new PlatformFailure('unavailable');
    } finally {
      live = false;
      key?.fill(0);
      for (const plaintext of plaintexts) plaintext.fill(0);
      await this.lifecycle.release(lease);
    }
  }
  private async rewrapImpl(
    identity: KeyIdentity,
    identityDigest: string,
  ): Promise<void> {
    // Authenticate the existing wrapper before closing admission; then drain before staging/installing.
    await this.withKey(identity, identityDigest, 'decrypt', async () => {});
    await this.lifecycle.fence(identity.userId, 'rewrap');
    const current = await this.repository.get(identity);
    const maintenance = await this.lifecycle.admitMaintenance(
      identity,
      identityDigest,
      fingerprint(current),
    );
    let next;
    try {
      next = await this.provider.rewrap(current, current.binding);
    } finally {
      await this.lifecycle.release(maintenance);
    }
    const fp = fingerprint(next),
      old = fingerprint(current);
    await this.lifecycle.stageWrapping(identity, old, fp);
    await this.repository.replace(next, current);
    await this.reconcileWrapping(identity);
  }
  reconcileWrapping(identity: KeyIdentity): Promise<void> {
    return this.run(() => this.reconcileWrappingImpl(identity));
  }
  private async reconcileWrappingImpl(identity: KeyIdentity): Promise<void> {
    const intent = await this.lifecycle.wrappingIntent(identity);
    if (!intent) throw new PlatformFailure('invalid');
    const current = await this.repository.get(identity);
    const fp = fingerprint(current);
    if (fp === intent.next)
      await this.lifecycle.replaceWrapping(
        identity,
        intent.previous,
        intent.next,
      );
    else if (fp !== intent.previous) throw new PlatformFailure('integrity');
    await this.lifecycle.finishWrapping(identity, fp);
  }
  async transaction<T>(
    scope: KeyScope,
    operation: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      scope.guard(tx);
      return operation(tx);
    });
  }
}
