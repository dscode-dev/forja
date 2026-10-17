import { Injectable } from '@nestjs/common';
import { Database, Transaction } from '../platform/database';
import { CryptoPlatform } from '../platform/crypto/crypto-platform';
import { KeyScope } from '../platform/crypto/key-service';
import {
  EncryptedRecord,
  EncryptedRow,
  hash,
} from '../platform/encrypted-record';
import { PrivacyErasure } from '../platform/privacy-erasure';
import { SessionPrincipal } from '../platform/auth-control';
import { IdentityService } from '../identity/identity.service';
import { PlatformFailure } from '../platform/failure';
import {
  FinanceService,
  FinanceReadUnitOfWork,
} from '../finance/finance.service';
import { GoalsService } from '../planning/goals/goals.service';
import { WorkService } from '../work/work.service';
import { id, idempotency, instant, page } from '../finance/validation';
import { integer } from '../work/model';
import {
  Basis,
  Mission,
  Award,
  Template,
  definitions,
  mission,
  template,
  progression,
  award,
} from './model';
interface MissionRow extends EncryptedRow {
  id: string;
  source_id: string;
  assigned_at: string;
  expires_at: string;
  recorded_at: string;
}
interface Head extends Record<string, unknown> {
  id: string;
  user_id: string;
  revision: number;
  source_id: string;
  assigned_at: string;
  expires_at: string;
  updated_at: string;
}
interface AwardRow extends EncryptedRow {
  mission_id: string;
  mission_revision: number;
  seq: number;
  recorded_at: string;
}
type Loaded = { row: MissionRow; value: Mission };
@Injectable()
export class GameService {
  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoPlatform,
    private readonly records: EncryptedRecord,
    private readonly identity: IdentityService,
    private readonly finance: FinanceService,
    private readonly goals: GoalsService,
    private readonly work: WorkService,
    erasure: PrivacyErasure,
  ) {
    erasure.register('game', async (tx, owner) => {
      for (const table of [
        'game_progression',
        'game_awards',
        'game_missions',
        'game_mission_history',
      ])
        await tx.query(`DELETE FROM app.${table} WHERE user_id=$1`, [owner]);
    });
  }
  async ready() {
    try {
      await this.db.query(
        'SELECT m.revision,h.revision,a.seq,p.seq FROM app.game_missions m CROSS JOIN app.game_mission_history h CROSS JOIN app.game_awards a CROSS JOIN app.game_progression p LIMIT 0',
      );
      return true;
    } catch {
      return false;
    }
  }
  private async owner(tx: Transaction, p: SessionPrincipal) {
    await tx.query("SELECT set_config('forja.user_id',$1,true)", [p.userId]);
    tx.beforeCommit(() => this.identity.assertOwner(p, p.userId));
    const r = await tx.query(
      "SELECT id FROM app.users WHERE id=$1 AND status='active' FOR NO KEY UPDATE",
      [p.userId],
    );
    if (r.rowCount !== 1) throw new PlatformFailure('fenced');
  }
  private async integrity(tx: Transaction, p: SessionPrincipal) {
    const orphan = await tx.query(
      'SELECT h.id FROM app.game_mission_history h WHERE h.user_id=$1 AND NOT EXISTS(SELECT 1 FROM app.game_missions m WHERE m.user_id=h.user_id AND m.id=h.id) LIMIT 1',
      [p.userId],
    );
    if (orphan.rowCount) throw new PlatformFailure('integrity');
  }
  private async read<T>(
    p: SessionPrincipal,
    fn: (tx: Transaction) => Promise<T>,
  ) {
    await this.identity.assertOwner(p, p.userId);
    return this.db.transaction(async (tx) => {
      await this.owner(tx, p);
      await this.integrity(tx, p);
      return fn(tx);
    });
  }
  private async command<T>(
    p: SessionPrincipal,
    financial: boolean,
    fn: (
      tx: Transaction,
      scope: KeyScope,
      u?: FinanceReadUnitOfWork,
    ) => Promise<T>,
  ) {
    await this.identity.assertOwner(p, p.userId);
    const active = await this.crypto.lifecycle.active(p.userId);
    return this.crypto.keys.withKey(active, p.binding, 'encrypt', (scope) =>
      financial
        ? this.finance.snapshot(p, async (u) => {
            scope.guard(u.tx);
            await this.integrity(u.tx, p);
            return fn(u.tx, scope, u);
          })
        : this.crypto.keys.transaction(scope, async (tx) => {
            await this.owner(tx, p);
            await this.integrity(tx, p);
            return fn(tx, scope);
          }),
    );
  }
  private meta(r: MissionRow) {
    return [r.source_id, r.assigned_at, r.expires_at, r.recorded_at];
  }
  private awardMeta(r: AwardRow) {
    return [r.mission_id, r.mission_revision, r.seq, r.recorded_at];
  }
  private async load(
    tx: Transaction,
    p: SessionPrincipal,
    target: string,
  ): Promise<Loaded> {
    const head = (
      await tx.query<Head>(
        'SELECT * FROM app.game_missions WHERE user_id=$1 AND id=$2',
        [p.userId, target],
      )
    ).rows[0];
    const row = (
      await tx.query<MissionRow>(
        'SELECT * FROM app.game_mission_history WHERE user_id=$1 AND id=$2 ORDER BY revision DESC LIMIT 1',
        [p.userId, target],
      )
    ).rows[0];
    if (!head) {
      if (row) throw new PlatformFailure('integrity');
      throw new PlatformFailure('not_found');
    }
    if (
      !row ||
      row.revision !== head.revision ||
      row.source_id !== head.source_id ||
      row.assigned_at !== head.assigned_at ||
      row.expires_at !== head.expires_at ||
      row.recorded_at !== head.updated_at
    )
      throw new PlatformFailure('integrity');
    const value = await this.records.open(
      p,
      row,
      'game.mission',
      target,
      this.meta(row),
      (raw) => {
        const v = mission(raw);
        instant(row.assigned_at);
        instant(row.expires_at);
        instant(row.recorded_at);
        if (
          Date.parse(row.expires_at) - Date.parse(row.assigned_at) !==
            30 * 86400000 ||
          row.recorded_at < row.assigned_at ||
          (v.completedAt !== null &&
            (v.completedAt < row.assigned_at ||
              v.completedAt >= row.expires_at ||
              v.completedAt > row.recorded_at))
        )
          throw new PlatformFailure('integrity');
        return v;
      },
      tx,
    );
    const reward = (
      await tx.query<AwardRow>(
        'SELECT * FROM app.game_awards WHERE user_id=$1 AND mission_id=$2',
        [p.userId, target],
      )
    ).rows[0];
    if ((value.state === 'COMPLETED') !== !!reward)
      throw new PlatformFailure('integrity');
    if (reward) {
      const a = await this.records.open(
        p,
        reward,
        'game.award',
        target,
        this.awardMeta(reward),
        award,
        tx,
      );
      if (
        a.template !== value.template ||
        reward.recorded_at !== value.completedAt
      )
        throw new PlatformFailure('integrity');
    }
    return { row, value };
  }
  private dto(m: Loaded) {
    const { row: r, value: v } = m;
    const d = definitions[v.template];
    return {
      id: r.id,
      revision: r.revision,
      template: v.template,
      definitionVersion: 1,
      category: d.category,
      title: d.title,
      description: d.description,
      assignedAt: r.assigned_at,
      recordedAt: r.recorded_at,
      expiresAt: r.expires_at,
      state: v.state,
      completedAt: v.completedAt,
      reconciliation: v.reconciliation,
      rewardXp: d.xp,
      rewardState: v.state === 'COMPLETED' ? 'AWARDED' : 'NOT_AWARDED',
      progress:
        v.template === 'WORK_PROFILE'
          ? {
              kind: 'confirmed-profile',
              current: v.current.revision > 0 ? 1 : 0,
              target: 1,
              currency: null,
              currentMinor: null,
              targetMinor: null,
            }
          : {
              kind: 'settled-goal',
              current: null,
              target: null,
              currency: v.basis.currency,
              currentMinor:
                v.current.currency === v.basis.currency &&
                v.current.accountId === v.basis.accountId &&
                v.current.targetMinor === v.basis.targetMinor
                  ? v.current.creditedMinor
                  : null,
              targetMinor: v.basis.targetMinor,
            },
    };
  }
  async get(p: SessionPrincipal, target: string) {
    id(target);
    return this.read(p, async (tx) => this.dto(await this.load(tx, p, target)));
  }
  async list(
    p: SessionPrincipal,
    after: string | null,
    limit: number,
    view: 'active' | 'history',
  ) {
    if (after !== null) id(after);
    limit = page(limit);
    return this.read(p, async (tx) => {
      const rows = (
        await tx.query<Head>(
          'SELECT * FROM app.game_missions WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3',
          [p.userId, after, limit + 1],
        )
      ).rows;
      const missions = [];
      for (const row of rows.slice(0, limit)) {
        const m = await this.load(tx, p, row.id);
        if ((view === 'active') === (m.value.state === 'ACTIVE'))
          missions.push(this.dto(m));
      }
      return {
        missions,
        next: rows.length > limit ? rows[limit - 1]!.id : null,
        view,
      };
    });
  }
  private async xp(tx: Transaction, p: SessionPrincipal) {
    const pointer = (
      await tx.query<{ seq: number }>(
        'SELECT seq FROM app.game_progression WHERE user_id=$1',
        [p.userId],
      )
    ).rows[0];
    const rows = (
      await tx.query<AwardRow>(
        'SELECT * FROM app.game_awards WHERE user_id=$1 ORDER BY seq DESC LIMIT 2',
        [p.userId],
      )
    ).rows;
    const count = (
      await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM app.game_awards WHERE user_id=$1',
        [p.userId],
      )
    ).rows[0]!.n;
    const row = rows[0];
    if (count !== (row?.seq ?? 0)) throw new PlatformFailure('integrity');
    if (!row) {
      if (pointer) throw new PlatformFailure('integrity');
      return { seq: 0, totalXp: 0, recent: null };
    }
    if (pointer?.seq !== row.seq) throw new PlatformFailure('integrity');
    const value = await this.records.open(
      p,
      row,
      'game.award',
      row.mission_id,
      this.awardMeta(row),
      award,
      tx,
    );
    let prior = 0;
    if (row.seq > 1) {
      const previous = rows[1];
      if (previous?.seq !== row.seq - 1) throw new PlatformFailure('integrity');
      prior = (
        await this.records.open(
          p,
          previous,
          'game.award',
          previous.mission_id,
          this.awardMeta(previous),
          award,
          tx,
        )
      ).totalXp;
    }
    if (prior + value.xp !== value.totalXp)
      throw new PlatformFailure('integrity');
    await this.load(tx, p, row.mission_id);
    return {
      seq: row.seq,
      totalXp: value.totalXp,
      recent: {
        missionId: row.mission_id,
        sequence: row.seq,
        xp: value.xp,
        recordedAt: row.recorded_at,
      },
    };
  }
  async summary(p: SessionPrincipal) {
    return this.read(p, async (tx) => {
      const v = await this.xp(tx, p);
      return { ...progression(v.totalXp), recentEvent: v.recent };
    });
  }
  private async now(tx: Transaction) {
    const r = (await tx.query<{ at: Date }>('SELECT clock_timestamp() AS at'))
      .rows[0]!;
    return r.at.toISOString();
  }
  private async facts(
    tx: Transaction,
    p: SessionPrincipal,
    t: Template,
    source: string,
    u?: FinanceReadUnitOfWork,
  ) {
    if (t === 'WORK_PROFILE') {
      const w = await this.work.missionFacts(tx, p);
      return {
        revision: w.revision,
        accountId: null,
        accountRevision: null,
        financeCursor: null,
        currency: null,
        targetMinor: null,
        creditedMinor: null,
      } satisfies Basis;
    }
    if (!u) throw new PlatformFailure('integrity');
    return this.goals.missionFacts(u, source);
  }
  private eligible(t: Template, f: Awaited<ReturnType<GameService['facts']>>) {
    return t === 'WORK_PROFILE'
      ? f.revision === 0
      : 'status' in f &&
          f.status === 'ACTIVE' &&
          f.accountState === 'active' &&
          BigInt(f.creditedMinor!) < BigInt(f.targetMinor!);
  }
  private basis(f: Awaited<ReturnType<GameService['facts']>>): Basis {
    return {
      revision: f.revision,
      accountId: f.accountId,
      accountRevision: f.accountRevision,
      financeCursor: f.financeCursor,
      currency: f.currency,
      targetMinor: f.targetMinor,
      creditedMinor: f.creditedMinor,
    };
  }
  async candidates(p: SessionPrincipal, goalId: string | null) {
    if (goalId !== null) id(goalId);
    const candidates = [];
    const used = await this.read(p, async (tx) =>
      (
        await tx.query<{ source_id: string }>(
          'SELECT source_id FROM app.game_missions WHERE user_id=$1 AND (source_id=$1::uuid OR source_id=$2::uuid)',
          [p.userId, goalId],
        )
      ).rows.map((r) => r.source_id),
    );
    const work = await this.read(p, (tx) =>
      this.facts(tx, p, 'WORK_PROFILE', p.userId),
    );
    if (!used.includes(p.userId) && this.eligible('WORK_PROFILE', work))
      candidates.push({
        template: 'WORK_PROFILE',
        goalId: null,
        goalRevision: null,
      });
    if (goalId !== null && !used.includes(goalId)) {
      id(goalId);
      const f = await this.finance.snapshot(p, (u) =>
        this.facts(u.tx, p, 'GOAL_TARGET', goalId, u),
      );
      if (this.eligible('GOAL_TARGET', f))
        for (const t of ['GOAL_TARGET', 'RESERVE_TARGET'])
          candidates.push({ template: t, goalId, goalRevision: f.revision });
    }
    return { candidates };
  }
  // Future AI may propose a template/source only; this read validates it without assigning/rewarding.
  async validateProposal(
    p: SessionPrincipal,
    t: Template,
    goalId: string | null,
  ) {
    template(t);
    const v = await this.candidates(p, goalId);
    return v.candidates.find((c) => c.template === t) ?? null;
  }
  private async append(
    tx: Transaction,
    scope: KeyScope,
    row: MissionRow,
    value: Mission,
  ) {
    mission(value);
    integer(row.revision, 2147483647, 1);
    const payload = await this.records.seal(
      scope,
      'game.mission',
      row.id,
      row.revision,
      this.meta(row),
      value,
    );
    await tx.query(
      'INSERT INTO app.game_mission_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        row.user_id,
        row.id,
        row.revision,
        row.source_id,
        row.assigned_at,
        row.expires_at,
        row.recorded_at,
        scope.identity.dekId,
        scope.identity.version,
        payload,
      ],
    );
    if (row.revision === 1)
      await tx.query(
        'INSERT INTO app.game_missions VALUES($1,$2,1,$3,$4,$5,$6)',
        [
          row.user_id,
          row.id,
          row.source_id,
          row.assigned_at,
          row.expires_at,
          row.recorded_at,
        ],
      );
    else {
      const r = await tx.query(
        'UPDATE app.game_missions SET revision=$3,updated_at=$4 WHERE user_id=$1 AND id=$2 AND revision=$5',
        [row.user_id, row.id, row.revision, row.recorded_at, row.revision - 1],
      );
      if (r.rowCount !== 1) throw new PlatformFailure('conflict');
    }
    return { row, value };
  }
  async assign(
    p: SessionPrincipal,
    key: string,
    rawTemplate: unknown,
    goalId: string | null,
    goalRevision: number | null,
  ) {
    idempotency(key);
    const t = template(rawTemplate),
      financial = t !== 'WORK_PROFILE';
    if (financial) {
      id(goalId);
      integer(goalRevision, 2147483647, 1);
    } else if (goalId !== null || goalRevision !== null)
      throw new PlatformFailure('invalid');
    const source = goalId ?? p.userId,
      fingerprint = hash(['game-assignment', 1, t, goalId, goalRevision]);
    return this.command(p, financial, async (tx, scope, u) => {
      const existing = (
        await tx.query<Head>(
          'SELECT * FROM app.game_missions WHERE user_id=$1 AND (id=$2 OR source_id=$3) ORDER BY (id=$2) DESC',
          [p.userId, key, source],
        )
      ).rows[0];
      if (existing) {
        const m = await this.load(tx, p, existing.id);
        if (
          m.value.template !== t ||
          (existing.id === key && m.value.fingerprint !== fingerprint)
        )
          throw new PlatformFailure('conflict');
        return this.dto(m);
      }
      const f = await this.facts(tx, p, t, source, u);
      if (!this.eligible(t, f) || (financial && f.revision !== goalRevision))
        throw new PlatformFailure('conflict');
      const at = await this.now(tx),
        expires = new Date(Date.parse(at) + 30 * 86400000).toISOString();
      const value: Mission = {
        template: t,
        version: 1,
        state: 'ACTIVE',
        fingerprint,
        basis: this.basis(f),
        current: this.basis(f),
        completedAt: null,
        reconciliation: 'UNCHANGED',
      };
      const row: MissionRow = {
        user_id: p.userId,
        id: key,
        revision: 1,
        source_id: source,
        assigned_at: at,
        expires_at: expires,
        recorded_at: at,
        dek_id: scope.identity.dekId,
        dek_version: scope.identity.version,
        payload: '',
      };
      return this.dto(await this.append(tx, scope, row, value));
    });
  }
  async evaluate(p: SessionPrincipal, target: string, cancel = false) {
    id(target);
    const initial = await this.get(p, target);
    return this.command(
      p,
      initial.template !== 'WORK_PROFILE',
      async (tx, scope, u) => {
        const m = await this.load(tx, p, target),
          at = await this.now(tx),
          old = m.value;
        if (
          old.state === 'EXPIRED' ||
          old.state === 'CANCELLED' ||
          (cancel && old.state === 'COMPLETED')
        )
          return this.dto(m);
        if (at < m.row.recorded_at) throw new PlatformFailure('unavailable');
        const v: Mission = { ...old };
        if (old.state === 'ACTIVE' && at >= m.row.expires_at)
          v.state = 'EXPIRED';
        else if (old.state === 'ACTIVE' && cancel) v.state = 'CANCELLED';
        else {
          const f = await this.facts(tx, p, old.template, m.row.source_id, u);
          const valid =
            old.template === 'WORK_PROFILE' ||
            ('status' in f &&
              ['ACTIVE', 'COMPLETED'].includes(f.status) &&
              f.accountState === 'active' &&
              f.accountId === old.basis.accountId &&
              f.currency === old.basis.currency &&
              f.targetMinor === old.basis.targetMinor);
          const qualifies =
            valid &&
            (old.template === 'WORK_PROFILE'
              ? f.revision > 0
              : BigInt(f.creditedMinor!) >= BigInt(old.basis.targetMinor!));
          v.current = this.basis(f);
          if (old.state === 'COMPLETED') {
            if (!qualifies) v.reconciliation = 'CHANGED';
          } else if (!valid) v.state = 'CANCELLED';
          else if (qualifies) {
            v.state = 'COMPLETED';
            v.completedAt = at;
          }
        }
        if (JSON.stringify(v) === JSON.stringify(old)) return this.dto(m);
        const result = await this.append(
          tx,
          scope,
          { ...m.row, revision: m.row.revision + 1, recorded_at: at },
          v,
        );
        if (v.state === 'COMPLETED' && old.state !== 'COMPLETED') {
          const prior = await this.xp(tx, p),
            seq = integer(prior.seq + 1, 2147483647, 1),
            delta = definitions[v.template].xp;
          const a: Award = {
            xp: delta,
            totalXp: prior.totalXp + delta,
            template: v.template,
            curveVersion: 1,
          };
          award(a);
          const payload = await this.records.seal(
            scope,
            'game.award',
            target,
            1,
            [target, result.row.revision, seq, at],
            a,
          );
          await tx.query(
            'INSERT INTO app.game_awards VALUES($1,$2,$3,$4,1,$5,$6,$7,$8)',
            [
              p.userId,
              target,
              result.row.revision,
              seq,
              at,
              scope.identity.dekId,
              scope.identity.version,
              payload,
            ],
          );
          await tx.query(
            'INSERT INTO app.game_progression VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET seq=EXCLUDED.seq',
            [p.userId, seq],
          );
        }
        return this.dto(result);
      },
    );
  }
}
