import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  FinanceService,
  FinanceReadUnitOfWork,
} from '../../finance/finance.service';
import { PlanningService } from '../planning.service';
import { WorkService } from '../../work/work.service';
import { capacity, integer } from '../../work/model';
import { IdentityService } from '../../identity/identity.service';
import { Database, Transaction } from '../../platform/database';
import { CryptoPlatform } from '../../platform/crypto/crypto-platform';
import { KeyScope } from '../../platform/crypto/key-service';
import {
  EncryptedRow,
  EncryptedRecord,
  hash,
} from '../../platform/encrypted-record';
import { PrivacyErasure } from '../../platform/privacy-erasure';
import { SessionPrincipal } from '../../platform/auth-control';
import { PlatformFailure } from '../../platform/failure';
import { Currency } from '../../finance/money';
import { id, idempotency, instant, page } from '../../finance/validation';
import { object } from '../../identity/validation';
import {
  GoalSnapshot,
  GoalStatus,
  goal,
  snapshot,
  calculate,
  CalculationInput,
  calculationInput,
  calendar,
  localDate,
  progress,
} from './model';
interface Head extends Record<string, unknown> {
  user_id: string;
  id: string;
  revision: number;
  account_id: string;
  currency: Currency;
  allocation: 'reserved' | 'released';
  created_at: string;
  updated_at: string;
}
interface History extends EncryptedRow {
  id: string;
  account_id: string;
  currency: Currency;
  allocation: string;
  created_at: string;
  recorded_at: string;
}
interface CalculationRow extends EncryptedRow {
  id: string;
  goal_id: string;
  goal_revision: number;
  generation: number;
  formula: number;
  work_revision: number | null;
  identity_revision: number;
  finance_cursor: string;
  recorded_at: string;
}
interface ReceiptRow extends EncryptedRow {
  id: string;
  kind: string;
  goal_id: string;
  goal_revision: number;
  calculation_id: string | null;
}
type Kind = 'create' | 'revise' | 'transition' | 'calculate';
interface Result {
  goalId: string;
  revision: number;
  calculationId: string | null;
}
@Injectable()
export class GoalsService {
  constructor(
    private readonly finance: FinanceService,
    private readonly planning: PlanningService,
    private readonly work: WorkService,
    private readonly identity: IdentityService,
    private readonly db: Database,
    private readonly crypto: CryptoPlatform,
    private readonly records: EncryptedRecord,
    erasure: PrivacyErasure,
  ) {
    erasure.register('planning-goals', async (tx, owner) => {
      for (const t of [
        'planning_goal_receipts',
        'planning_goal_calculations',
        'planning_goals',
        'planning_goal_history',
      ])
        await tx.query(`DELETE FROM app.${t} WHERE user_id=$1`, [owner]);
    });
  }
  async ready() {
    try {
      await this.db.query(
        'SELECT g.revision,h.revision,c.generation,r.id FROM app.planning_goals g CROSS JOIN app.planning_goal_history h CROSS JOIN app.planning_goal_calculations c CROSS JOIN app.planning_goal_receipts r LIMIT 0',
      );
      return true;
    } catch {
      return false;
    }
  }
  private async read<T>(
    p: SessionPrincipal,
    fn: (tx: Transaction) => Promise<T>,
  ) {
    await this.identity.assertOwner(p, p.userId);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [p.userId]);
      tx.beforeCommit(() => this.identity.assertOwner(p, p.userId));
      const active = await tx.query(
        "SELECT id FROM app.users WHERE id=$1 AND status='active' FOR NO KEY UPDATE",
        [p.userId],
      );
      if (active.rowCount !== 1) throw new PlatformFailure('fenced');
      return fn(tx);
    });
  }
  private historyMeta(r: History) {
    return [
      r.account_id,
      r.currency,
      r.allocation,
      r.created_at,
      r.recorded_at,
    ];
  }
  private async load(
    tx: Transaction,
    p: SessionPrincipal,
    target: string,
    revision?: number,
  ) {
    const head = (
      await tx.query<Head>(
        'SELECT * FROM app.planning_goals WHERE user_id=$1 AND id=$2',
        [p.userId, target],
      )
    ).rows[0];
    if (!head) throw new PlatformFailure('not_found');
    const latest = (
      await tx.query<History>(
        'SELECT * FROM app.planning_goal_history WHERE user_id=$1 AND id=$2 ORDER BY revision DESC LIMIT 1',
        [p.userId, target],
      )
    ).rows[0];
    if (
      !latest ||
      latest.revision !== head.revision ||
      latest.account_id !== head.account_id ||
      latest.currency !== head.currency ||
      latest.allocation !== head.allocation ||
      latest.created_at !== head.created_at ||
      latest.recorded_at !== head.updated_at
    )
      throw new PlatformFailure('integrity');
    if (revision !== undefined && revision > head.revision)
      throw new PlatformFailure('not_found');
    const row =
      revision === undefined || revision === head.revision
        ? latest
        : (
            await tx.query<History>(
              'SELECT * FROM app.planning_goal_history WHERE user_id=$1 AND id=$2 AND revision=$3',
              [p.userId, target, revision],
            )
          ).rows[0];
    if (!row) throw new PlatformFailure('integrity');
    const value = await this.records.open(
      p,
      row,
      'planning.goal-snapshot',
      target,
      this.historyMeta(row),
      (raw) => {
        const value = snapshot(raw);
        instant(row.created_at);
        instant(row.recorded_at);
        if (
          value.goal.fundingAccountId !== row.account_id ||
          value.goal.currency !== row.currency ||
          (value.status === 'CANCELLED' ? 'released' : 'reserved') !==
            row.allocation ||
          row.created_at > row.recorded_at ||
          (row.revision === 1) !== (value.action === 'created')
        )
          throw new PlatformFailure('integrity');
        return value;
      },
      tx,
    );
    return {
      id: row.id,
      revision: row.revision,
      createdAt: row.created_at,
      recordedAt: row.recorded_at,
      ...value,
    };
  }
  async get(p: SessionPrincipal, target: string, revision?: number) {
    id(target);
    if (revision !== undefined) integer(revision, 2147483647, 1);
    const v = await this.read(p, (tx) => this.load(tx, p, target, revision));
    return {
      id: v.id,
      revision: v.revision,
      createdAt: v.createdAt,
      recordedAt: v.recordedAt,
      status: v.status,
      goal: v.goal,
      completion: v.completion,
    };
  }
  async list(p: SessionPrincipal, after: string | null, limit: number) {
    if (after !== null) id(after);
    limit = page(limit);
    return this.read(p, async (tx) => {
      const rows = (
        await tx.query<Head>(
          'SELECT * FROM app.planning_goals WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3',
          [p.userId, after, limit + 1],
        )
      ).rows;
      const goals = [];
      for (const r of rows.slice(0, limit)) {
        const v = await this.load(tx, p, r.id);
        goals.push({
          id: v.id,
          revision: v.revision,
          createdAt: v.createdAt,
          recordedAt: v.recordedAt,
          status: v.status,
          goal: v.goal,
          completion: v.completion,
        });
      }
      return { goals, next: rows.length > limit ? rows[limit - 1]!.id : null };
    });
  }
  private async receipt(
    tx: Transaction,
    p: SessionPrincipal,
    kind: Kind,
    key: string,
    fingerprint: string,
  ): Promise<Result | null> {
    const row = (
      await tx.query<ReceiptRow>(
        'SELECT * FROM app.planning_goal_receipts WHERE user_id=$1 AND kind=$2 AND id=$3',
        [p.userId, kind, key],
      )
    ).rows[0];
    if (!row) return null;
    const stored = await this.records.open(
      p,
      row,
      'planning.goal-receipt',
      key,
      [kind, row.goal_id, row.goal_revision, row.calculation_id],
      (raw) => {
        const r = object(raw, ['fingerprint']);
        if (
          typeof r['fingerprint'] !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(r['fingerprint'])
        )
          throw new PlatformFailure('invalid');
        return r['fingerprint'];
      },
      tx,
    );
    if (stored !== fingerprint) throw new PlatformFailure('conflict');
    return {
      goalId: row.goal_id,
      revision: row.goal_revision,
      calculationId: row.calculation_id,
    };
  }
  private async command(
    p: SessionPrincipal,
    kind: Kind,
    key: string,
    semantics: unknown,
    operation: (u: FinanceReadUnitOfWork, scope: KeyScope) => Promise<Result>,
  ) {
    await this.identity.assertOwner(p, p.userId);
    idempotency(key);
    const fingerprint = hash(['forja-goal-command', 1, kind, semantics]);
    const active = await this.crypto.lifecycle.active(p.userId);
    return this.crypto.keys.withKey(active, p.binding, 'encrypt', (scope) =>
      this.finance.snapshot(p, async (u) => {
        scope.guard(u.tx);
        const prior = await this.receipt(u.tx, p, kind, key, fingerprint);
        if (prior) return prior;
        const result = await operation(u, scope);
        const payload = await this.records.seal(
          scope,
          'planning.goal-receipt',
          key,
          1,
          [kind, result.goalId, result.revision, result.calculationId],
          { fingerprint },
        );
        await u.tx.query(
          'INSERT INTO app.planning_goal_receipts VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9)',
          [
            p.userId,
            kind,
            key,
            result.goalId,
            result.revision,
            result.calculationId,
            active.dekId,
            active.version,
            payload,
          ],
        );
        return result;
      }),
    );
  }
  private async reservation(
    tx: Transaction,
    p: SessionPrincipal,
    accountId: string,
    target: string,
  ) {
    const other = await tx.query(
      "SELECT id FROM app.planning_goals WHERE user_id=$1 AND account_id=$2 AND allocation='reserved' AND id<>$3",
      [p.userId, accountId, target],
    );
    if (other.rowCount) throw new PlatformFailure('conflict');
  }
  private async append(
    u: FinanceReadUnitOfWork,
    scope: KeyScope,
    target: string,
    revision: number,
    createdAt: string,
    value: GoalSnapshot,
    previousAt = createdAt,
  ) {
    const at = new Date().toISOString(),
      allocation = value.status === 'CANCELLED' ? 'released' : 'reserved';
    snapshot(value);
    if (at < previousAt) throw new PlatformFailure('unavailable');
    const payload = await this.records.seal(
      scope,
      'planning.goal-snapshot',
      target,
      revision,
      [
        value.goal.fundingAccountId,
        value.goal.currency,
        allocation,
        createdAt,
        at,
      ],
      value,
    );
    await u.tx.query(
      'INSERT INTO app.planning_goal_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        u.principal.userId,
        target,
        revision,
        value.goal.fundingAccountId,
        value.goal.currency,
        allocation,
        createdAt,
        at,
        scope.identity.dekId,
        scope.identity.version,
        payload,
      ],
    );
    if (revision === 1)
      await u.tx.query(
        'INSERT INTO app.planning_goals VALUES($1,$2,1,$3,$4,$5,$6,$7)',
        [
          u.principal.userId,
          target,
          value.goal.fundingAccountId,
          value.goal.currency,
          allocation,
          createdAt,
          at,
        ],
      );
    else {
      const changed = await u.tx.query(
        'UPDATE app.planning_goals SET revision=$3,account_id=$4,currency=$5,allocation=$6,updated_at=$7 WHERE user_id=$1 AND id=$2 AND revision=$8',
        [
          u.principal.userId,
          target,
          revision,
          value.goal.fundingAccountId,
          value.goal.currency,
          allocation,
          at,
          revision - 1,
        ],
      );
      if (changed.rowCount !== 1) throw new PlatformFailure('conflict');
    }
    return { goalId: target, revision, calculationId: null };
  }
  async create(p: SessionPrincipal, key: string, input: unknown) {
    const value = goal(input);
    const r = await this.command(p, 'create', key, value, async (u, scope) => {
      const account = await this.finance.requireAccount(
        u,
        value.fundingAccountId,
      );
      if (account.row.currency !== value.currency)
        throw new PlatformFailure('invalid');
      if (account.row.state !== 'active') throw new PlatformFailure('conflict');
      const target = randomUUID();
      await this.reservation(u.tx, p, value.fundingAccountId, target);
      return this.append(u, scope, target, 1, new Date().toISOString(), {
        goal: value,
        status: 'ACTIVE',
        action: 'created',
        completion: null,
      });
    });
    return this.get(p, r.goalId, r.revision);
  }
  async revise(
    p: SessionPrincipal,
    target: string,
    key: string,
    revision: number,
    input: unknown,
  ) {
    id(target);
    integer(revision, 2147483646, 1);
    const value = goal(input);
    const r = await this.command(
      p,
      'revise',
      key,
      { target, revision, goal: value },
      async (u, scope) => {
        const current = await this.load(u.tx, p, target);
        if (
          current.revision !== revision ||
          !['ACTIVE', 'PAUSED'].includes(current.status)
        )
          throw new PlatformFailure('conflict');
        if (current.recordedAt > new Date().toISOString())
          throw new PlatformFailure('unavailable');
        const account = await this.finance.requireAccount(
          u,
          value.fundingAccountId,
        );
        if (account.row.currency !== value.currency)
          throw new PlatformFailure('invalid');
        if (account.row.state !== 'active')
          throw new PlatformFailure('conflict');
        await this.reservation(u.tx, p, value.fundingAccountId, target);
        return this.append(
          u,
          scope,
          target,
          revision + 1,
          current.createdAt,
          {
            goal: value,
            status: current.status,
            action: 'revised',
            completion: null,
          },
          current.recordedAt,
        );
      },
    );
    return this.get(p, r.goalId, r.revision);
  }
  async transition(
    p: SessionPrincipal,
    target: string,
    key: string,
    revision: number,
    action: string,
  ) {
    id(target);
    integer(revision, 2147483646, 1);
    if (!['pause', 'resume', 'complete', 'cancel'].includes(action))
      throw new PlatformFailure('invalid');
    const r = await this.command(
      p,
      'transition',
      key,
      { target, revision, action },
      async (u, scope) => {
        const current = await this.load(u.tx, p, target);
        if (
          current.revision !== revision ||
          current.status === 'CANCELLED' ||
          (action === 'pause' && current.status !== 'ACTIVE') ||
          (action === 'resume' &&
            !['PAUSED', 'COMPLETED'].includes(current.status)) ||
          (action === 'complete' && current.status !== 'ACTIVE')
        )
          throw new PlatformFailure('conflict');
        let completion: GoalSnapshot['completion'] = null;
        if (action === 'complete') {
          const account = await this.finance.requireAccount(
            u,
            current.goal.fundingAccountId,
          );
          const credited = progress(
            current.goal.targetMinor,
            account.value.balanceMinor,
          );
          if (account.row.state !== 'active' || credited.remainingMinor !== '0')
            throw new PlatformFailure('conflict');
          completion = {
            financeCursor: u.seq,
            accountRevision: account.row.revision,
            creditedMinor: credited.creditedMinor,
          };
        }
        const state: GoalStatus =
          action === 'pause'
            ? 'PAUSED'
            : action === 'resume'
              ? 'ACTIVE'
              : action === 'complete'
                ? 'COMPLETED'
                : 'CANCELLED';
        return this.append(
          u,
          scope,
          target,
          revision + 1,
          current.createdAt,
          {
            goal: current.goal,
            status: state,
            action:
              action === 'pause'
                ? 'paused'
                : action === 'resume'
                  ? 'resumed'
                  : action === 'complete'
                    ? 'completed'
                    : 'cancelled',
            completion,
          },
          current.recordedAt,
        );
      },
    );
    return this.get(p, r.goalId, r.revision);
  }
  async progress(p: SessionPrincipal, target: string) {
    id(target);
    return this.finance.snapshot(p, async (u) => {
      const current = await this.load(u.tx, p, target),
        account = await this.finance.requireAccount(
          u,
          current.goal.fundingAccountId,
        );
      return {
        goalId: target,
        goalRevision: current.revision,
        status: current.status,
        currency: current.goal.currency,
        funding: 'dedicated-account-attribution',
        accountId: account.row.id,
        accountState: account.row.state,
        settledBalanceMinor: account.value.balanceMinor,
        ...progress(
          current.goal.targetMinor,
          account.value.balanceMinor,
          current.status !== 'CANCELLED',
        ),
        financeCursor: u.seq,
        accountCursor: Number(account.row.last_seq),
        accountRevision: account.row.revision,
        evaluatedAt: new Date().toISOString(),
      };
    });
  }
  private calcMeta(row: CalculationRow) {
    return [
      row.goal_id,
      row.goal_revision,
      row.generation,
      row.formula,
      row.work_revision,
      row.identity_revision,
      Number(row.finance_cursor),
      row.recorded_at,
    ];
  }
  async getCalculation(
    p: SessionPrincipal,
    target: string,
    calculationId: string | null,
  ) {
    id(target);
    if (calculationId !== null) id(calculationId);
    return this.read(p, async (tx) => {
      const row = (
        await tx.query<CalculationRow>(
          'SELECT * FROM app.planning_goal_calculations WHERE user_id=$1 AND goal_id=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY generation DESC LIMIT 1',
          [p.userId, target, calculationId],
        )
      ).rows[0];
      if (!row) throw new PlatformFailure('not_found');
      const input = await this.records.open(
        p,
        row,
        'planning.goal-calculation',
        row.id,
        this.calcMeta(row),
        (raw) => {
          const value = calculationInput(raw);
          if (
            value.goalRevision !== row.goal_revision ||
            (value.work?.revision ?? null) !== row.work_revision ||
            value.identityProfileRevision !== row.identity_revision ||
            value.finance.cursor !== Number(row.finance_cursor) ||
            value.asOf !== row.recorded_at ||
            value.formulaVersion !== row.formula
          )
            throw new PlatformFailure('integrity');
          return value;
        },
        tx,
      );
      return {
        calculationId: row.id,
        goalId: target,
        generation: row.generation,
        recordedAt: row.recorded_at,
        ...calculate(input),
      };
    });
  }
  async generate(
    p: SessionPrincipal,
    target: string,
    key: string,
    expectedRevision: number,
    workRevision: number | null,
    projectCount: number | null,
  ) {
    id(target);
    idempotency(key);
    integer(expectedRevision, 2147483647, 1);
    if (workRevision !== null) integer(workRevision, 2147483647, 1);
    if (projectCount !== null) integer(projectCount, 1000);
    const semantics = { target, expectedRevision, workRevision, projectCount };
    const prior = await this.read(p, (tx) =>
      this.receipt(
        tx,
        p,
        'calculate',
        key,
        hash(['forja-goal-command', 1, 'calculate', semantics]),
      ),
    );
    if (prior) return this.getCalculation(p, target, prior.calculationId);
    const identityProfile = await this.identity.profile(p);
    let workProfile: Awaited<ReturnType<WorkService['profile']>> | null = null;
    try {
      workProfile = await this.work.profile(p, workRevision ?? undefined);
    } catch (e) {
      if (!(
        e instanceof PlatformFailure &&
        e.code === 'not_found' &&
        workRevision === null
      ))
        throw e;
    }
    if (
      projectCount !== null &&
      !workProfile?.profile.components.some((c) => c.kind === 'PER_PROJECT')
    )
      throw new PlatformFailure('invalid');
    const profile = workProfile;
    const result = await this.command(
      p,
      'calculate',
      key,
      semantics,
      async (u, scope) => {
        const current = await this.load(u.tx, p, target);
        if (current.revision !== expectedRevision)
          throw new PlatformFailure('conflict');
        const account = await this.finance.requireAccount(
          u,
          current.goal.fundingAccountId,
        );
        if (account.row.state !== 'active')
          throw new PlatformFailure('conflict');
        const asOf = new Date().toISOString(),
          today = localDate(asOf, identityProfile.timezone),
          from =
            today > current.goal.startDate ? today : current.goal.startDate;
        const time = calendar(from, current.goal.deadline, null);
        if (asOf < current.recordedAt || (profile && asOf < profile.recordedAt))
          throw new PlatformFailure('unavailable');
        let work: CalculationInput['work'] = null;
        if (profile) {
          const declared =
            time.days > 0 && time.days <= 366
              ? capacity(profile.profile, {
                  from,
                  through: current.goal.deadline,
                  ...(projectCount === null ? {} : { projectCount }),
                })
              : null;
          work = {
            revision: profile.revision,
            recordedAt: profile.recordedAt,
            currency: profile.profile.currency,
            minutesPerDay: profile.profile.availability.availableMinutesPerDay,
            weekdays: profile.profile.availability.preferredWeekdays,
            capacityMinor: declared?.totalMinor ?? null,
            capacityReason:
              time.days === 0
                ? 'expired'
                : time.days > 366
                  ? 'work-horizon-bound'
                  : declared?.totalMinor === null
                    ? 'unknown-components'
                    : 'known',
            monthlyDeclaredMinor:
              profile.profile.earningModel === 'FIXED_MONTHLY'
                ? profile.profile.components[0]!.amountMinor
                : null,
            projectCount,
          };
        }
        const input: CalculationInput = {
          formulaVersion: 1,
          goalRevision: current.revision,
          status: current.status,
          targetMinor: current.goal.targetMinor,
          currency: current.goal.currency,
          startDate: current.goal.startDate,
          deadline: current.goal.deadline,
          retainedEarningsBasisPoints: current.goal.retainedEarningsBasisPoints,
          asOf,
          calculationDate: today,
          timezone: identityProfile.timezone,
          identityProfileRevision: identityProfile.revision,
          work,
          finance: {
            cursor: u.seq,
            accountId: account.row.id,
            accountCursor: Number(account.row.last_seq),
            accountRevision: account.row.revision,
            balanceMinor: account.value.balanceMinor,
          },
          expected: await this.planning.goalInputs(
            u,
            account.row.id,
            account.row.currency,
            current.goal.deadline,
            identityProfile.timezone,
          ),
        };
        calculate(input);
        const generation = integer(
            Number(
              (
                await u.tx.query<{ last: number }>(
                  'SELECT coalesce(max(generation),0) AS last FROM app.planning_goal_calculations WHERE user_id=$1 AND goal_id=$2',
                  [p.userId, target],
                )
              ).rows[0]!.last,
            ) + 1,
            2147483647,
            1,
          ),
          calculationId = randomUUID();
        const meta = [
          target,
          current.revision,
          generation,
          1,
          work?.revision ?? null,
          identityProfile.revision,
          u.seq,
          asOf,
        ];
        const payload = await this.records.seal(
          scope,
          'planning.goal-calculation',
          calculationId,
          1,
          meta,
          input,
        );
        await u.tx.query(
          'INSERT INTO app.planning_goal_calculations VALUES($1,$2,$3,$4,$5,1,1,$6,$7,$8,$9,$10,$11,$12)',
          [
            p.userId,
            calculationId,
            target,
            current.revision,
            generation,
            work?.revision ?? null,
            identityProfile.revision,
            u.seq,
            asOf,
            scope.identity.dekId,
            scope.identity.version,
            payload,
          ],
        );
        return { goalId: target, revision: current.revision, calculationId };
      },
    );
    return this.getCalculation(p, target, result.calculationId);
  }
  async advisoryFacts(
    p: SessionPrincipal,
    target: string,
    calculationId: string,
  ) {
    const v = await this.getCalculation(p, target, calculationId);
    return {
      goalId: v.goalId,
      calculationId: v.calculationId,
      generation: v.generation,
      formulaVersion: v.formulaVersion,
      goalRevision: v.goalRevision,
      workRevision: v.workRevision,
      financeCursor: v.financeCursor,
      asOf: v.asOf,
      currency: v.currency,
      days: v.days,
      conservative: v.conservative,
      planned: v.planned,
    };
  }
}
