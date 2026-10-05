import { Injectable } from '@nestjs/common';
import { Database, Transaction } from '../platform/database';
import { CryptoPlatform } from '../platform/crypto/crypto-platform';
import { EncryptedRecord, EncryptedRow } from '../platform/encrypted-record';
import { SessionPrincipal } from '../platform/auth-control';
import { IdentityService } from '../identity/identity.service';
import { PrivacyErasure } from '../platform/privacy-erasure';
import { PlatformFailure } from '../platform/failure';
import { profile, capacity, integer, Horizon } from './model';
interface SnapshotRow extends EncryptedRow {
  recorded_at: string;
  event: string;
}
@Injectable()
export class WorkService {
  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoPlatform,
    private readonly records: EncryptedRecord,
    private readonly identity: IdentityService,
    erasure: PrivacyErasure,
  ) {
    erasure.register('work', async (tx, owner) => {
      await tx.query('DELETE FROM app.work_profiles WHERE user_id=$1', [owner]);
      await tx.query('DELETE FROM app.work_profile_history WHERE user_id=$1', [
        owner,
      ]);
    });
  }
  async ready(): Promise<boolean> {
    try {
      await this.db.query(
        'SELECT p.revision,h.recorded_at FROM app.work_profiles p CROSS JOIN app.work_profile_history h LIMIT 0',
      );
      return true;
    } catch {
      return false;
    }
  }
  private async owner(tx: Transaction, p: SessionPrincipal) {
    await tx.query("SELECT set_config('forja.user_id',$1,true)", [p.userId]);
    tx.beforeCommit(() => this.identity.assertOwner(p, p.userId));
    const owner = await tx.query(
      "SELECT id FROM app.users WHERE id=$1 AND status='active' FOR NO KEY UPDATE",
      [p.userId],
    );
    if (owner.rowCount !== 1) throw new PlatformFailure('fenced');
  }
  private async head(tx: Transaction, p: SessionPrincipal): Promise<number> {
    const result = (
      await tx.query<{ revision: number | null; latest: number | null }>(
        'SELECT (SELECT revision FROM app.work_profiles WHERE user_id=$1) AS revision, (SELECT max(revision) FROM app.work_profile_history WHERE user_id=$1) AS latest',
        [p.userId],
      )
    ).rows[0]!;
    if (result.revision !== result.latest)
      throw new PlatformFailure('integrity');
    return result.revision ?? 0;
  }
  private async read(tx: Transaction, p: SessionPrincipal, revision: number) {
    const row = (
      await tx.query<SnapshotRow>(
        'SELECT * FROM app.work_profile_history WHERE user_id=$1 AND revision=$2',
        [p.userId, revision],
      )
    ).rows[0];
    if (!row) throw new PlatformFailure('integrity');
    const value = await this.records.open(
      p,
      row,
      'work.profile-snapshot',
      p.userId,
      [row.recorded_at, row.event],
      (raw) => {
        if (
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
            row.recorded_at,
          ) ||
          new Date(row.recorded_at).toISOString() !== row.recorded_at ||
          !['created', 'updated', 'model-changed'].includes(row.event) ||
          (row.revision === 1) !== (row.event === 'created')
        )
          throw new PlatformFailure('integrity');
        return profile(raw);
      },
      tx,
    );
    return {
      revision: row.revision,
      recordedAt: row.recorded_at,
      effectiveAt: row.recorded_at,
      profile: value,
    };
  }
  async profile(p: SessionPrincipal, revision?: number) {
    if (revision !== undefined) integer(revision, 2147483647, 1);
    await this.identity.assertOwner(p, p.userId);
    return this.db.transaction(async (tx) => {
      await this.owner(tx, p);
      const current = await this.head(tx, p);
      if (!current || (revision !== undefined && revision > current))
        throw new PlatformFailure('not_found');
      return this.read(tx, p, revision ?? current);
    });
  }
  async replace(p: SessionPrincipal, expectedRevision: number, input: unknown) {
    const value = profile(input);
    integer(expectedRevision, 2147483646);
    await this.identity.assertOwner(p, p.userId);
    const active = await this.crypto.lifecycle.active(p.userId);
    return this.crypto.keys.withKey(active, p.binding, 'encrypt', (scope) =>
      this.crypto.keys.transaction(scope, async (tx) => {
        await this.owner(tx, p);
        const current = await this.head(tx, p);
        if (current !== expectedRevision) throw new PlatformFailure('conflict');
        const previous = current ? await this.read(tx, p, current) : null;
        const revision = current + 1,
          recordedAt = new Date().toISOString();
        if (previous && recordedAt < previous.recordedAt)
          throw new PlatformFailure('unavailable');
        const event = !previous
          ? 'created'
          : previous.profile.earningModel !== value.earningModel
            ? 'model-changed'
            : 'updated';
        const payload = await this.records.seal(
          scope,
          'work.profile-snapshot',
          p.userId,
          revision,
          [recordedAt, event],
          value,
        );
        await tx.query(
          'INSERT INTO app.work_profile_history(user_id,revision,recorded_at,event,dek_id,dek_version,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            p.userId,
            revision,
            recordedAt,
            event,
            active.dekId,
            active.version,
            payload,
          ],
        );
        if (current) {
          const changed = await tx.query(
            'UPDATE app.work_profiles SET revision=$2 WHERE user_id=$1 AND revision=$3',
            [p.userId, revision, current],
          );
          if (changed.rowCount !== 1) throw new PlatformFailure('conflict');
        } else
          await tx.query(
            'INSERT INTO app.work_profiles(user_id,revision) VALUES($1,$2)',
            [p.userId, revision],
          );
        return {
          revision,
          recordedAt,
          effectiveAt: recordedAt,
          profile: value,
        };
      }),
    );
  }
  async capacity(p: SessionPrincipal, horizon: Horizon, revision?: number) {
    const snapshot = await this.profile(p, revision);
    return {
      profileRevision: snapshot.revision,
      recordedAt: snapshot.recordedAt,
      effectiveAt: snapshot.effectiveAt,
      ...capacity(snapshot.profile, horizon),
    };
  }
  async careerContext(p: SessionPrincipal) {
    const { revision, profile: value } = await this.profile(p);
    return {
      profileRevision: revision,
      workStatus: value.workStatus,
      workModel: value.workModel,
      skills: value.skills,
      desiredDirection: value.desiredDirection,
    };
  }
}
