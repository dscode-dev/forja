import { localDate } from '../planning/goals/model';
import { Injectable } from '@nestjs/common';
import { Database, Transaction } from '../platform/database';
import {
  EncryptedRecord,
  EncryptedRow,
  hash,
} from '../platform/encrypted-record';
import { PrivacyErasure } from '../platform/privacy-erasure';
import { CryptoPlatform } from '../platform/crypto/crypto-platform';
import { IdentityService } from '../identity/identity.service';
import { SessionPrincipal } from '../platform/auth-control';
import { FinanceService } from '../finance/finance.service';
import { PlanningService } from '../planning/planning.service';
import { GoalsService } from '../planning/goals/goals.service';
import { WorkService } from '../work/work.service';
import { capacity, integer } from '../work/model';
import { GameService } from '../game/game.service';
import { SafeLogger } from '../platform/safe-logger';
import { PlatformFailure } from '../platform/failure';
import { ReadBudget } from '../platform/read-budget';
import { id, idempotency } from '../finance/validation';
import { currency, minor } from '../finance/money';
import { object } from '../identity/validation';
import { command, periods, comparison, ReportCommand } from './model';
interface RequestRow extends EncryptedRow {
  id: string;
  generation: number;
  recorded_at: string;
  expires_at: string;
}
interface SnapshotRow extends EncryptedRow {
  id: string;
  recorded_at: string;
  expires_at: string;
}
@Injectable()
export class ReportingService {
  constructor(
    private readonly db: Database,
    private readonly records: EncryptedRecord,
    private readonly crypto: CryptoPlatform,
    private readonly identity: IdentityService,
    private readonly finance: FinanceService,
    private readonly planning: PlanningService,
    private readonly goals: GoalsService,
    private readonly work: WorkService,
    private readonly game: GameService,
    private readonly logger: SafeLogger,
    erasure: PrivacyErasure,
  ) {
    erasure.register('reporting', async (tx, owner) => {
      await tx.query('DELETE FROM app.report_snapshots WHERE user_id=$1', [
        owner,
      ]);
      await tx.query('DELETE FROM app.report_requests WHERE user_id=$1', [
        owner,
      ]);
    });
  }
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private sweepCursor = '00000000-0000-0000-0000-000000000000';
  private sweeping = false;
  onModuleInit() {
    this.sweepTimer = setInterval(() => {
      void this.sweepExpired().catch(() =>
        this.logger.event('reporting.retention', 'unavailable'),
      );
    }, 60000);
    this.sweepTimer.unref();
  }
  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }
  // Technical retention only: indexed owner IDs, no decryption/session impersonation/report analytics.
  async sweepExpired() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const owners = (
        await this.db.query<{ id: string }>(
          'SELECT id FROM app.users WHERE id>$1 ORDER BY id LIMIT 100',
          [this.sweepCursor],
        )
      ).rows;
      for (const owner of owners)
        await this.db.transaction(async (tx) => {
          await tx.query("SELECT set_config('forja.user_id',$1,true)", [
            owner.id,
          ]);
          await tx.query(
            'SELECT id FROM app.users WHERE id=$1 FOR NO KEY UPDATE',
            [owner.id],
          );
          await this.cleanup(tx, { userId: owner.id });
        });
      this.sweepCursor =
        owners.length === 100
          ? owners[99]!.id
          : '00000000-0000-0000-0000-000000000000';
    } finally {
      this.sweeping = false;
    }
  }
  async options(p: SessionPrincipal) {
    const profile = await this.identity.profile(p);
    return {
      reportVersion: 1,
      today: localDate(new Date().toISOString(), profile.timezone),
      timezone: profile.timezone,
      locale: profile.locale,
    };
  }
  async ready() {
    try {
      await this.db.query(
        'SELECT r.id,s.id FROM app.report_requests r CROSS JOIN app.report_snapshots s LIMIT 0',
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
  private async now(tx: Transaction) {
    return (
      await tx.query<{ at: Date }>('SELECT clock_timestamp() AS at')
    ).rows[0]!.at.toISOString();
  }
  private async cleanup(tx: Transaction, p: Pick<SessionPrincipal, 'userId'>) {
    await tx.query(
      'DELETE FROM app.report_snapshots WHERE user_id=$1 AND id IN(SELECT id FROM app.report_snapshots WHERE user_id=$1 AND expires_at<=to_char(clock_timestamp() AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') ORDER BY expires_at LIMIT 100)',
      [p.userId],
    );
  }
  private async read<T>(
    p: SessionPrincipal,
    fn: (tx: Transaction) => Promise<T>,
  ) {
    await this.identity.assertOwner(p, p.userId);
    return this.db.transaction(async (tx) => {
      await this.owner(tx, p);
      await this.cleanup(tx, p);
      return fn(tx);
    });
  }
  private meta(r: RequestRow) {
    return [r.generation, r.recorded_at, r.expires_at];
  }
  private async request(tx: Transaction, p: SessionPrincipal, r: RequestRow) {
    return this.records.open(
      p,
      r,
      'reporting.request',
      r.id,
      this.meta(r),
      (raw) => {
        const b = object(raw, ['command', 'fingerprint']);
        const c = command(b['command']);
        if (b['fingerprint'] !== hash(['report-command', 1, c]))
          throw new PlatformFailure('integrity');
        return { command: c, fingerprint: b['fingerprint'] };
      },
      tx,
    );
  }
  private async load(tx: Transaction, p: SessionPrincipal, r: RequestRow) {
    const receipt = await this.request(tx, p, r);
    if (r.expires_at <= (await this.now(tx)))
      throw new PlatformFailure('not_found');
    const row = (
      await tx.query<SnapshotRow>(
        'SELECT * FROM app.report_snapshots WHERE user_id=$1 AND id=$2',
        [p.userId, r.id],
      )
    ).rows[0];
    if (!row) throw new PlatformFailure('not_found');
    if (row.recorded_at !== r.recorded_at || row.expires_at !== r.expires_at)
      throw new PlatformFailure('integrity');
    const facts = await this.records.open(
      p,
      row,
      'reporting.snapshot',
      r.id,
      [r.recorded_at, r.expires_at],
      (raw) => {
        const b = object(raw, [
          'reportVersion',
          'request',
          'period',
          'generatedAt',
          'locale',
          'tzdb',
          'identityRevision',
          'finance',
          'settled',
          'previous',
          'comparisons',
          'planning',
          'goal',
          'work',
          'game',
          'reserve',
          'inputsRead',
        ]);
        if (
          b['reportVersion'] !== 1 ||
          b['generatedAt'] !== r.recorded_at ||
          JSON.stringify(b['request']) !== JSON.stringify(receipt.command)
        )
          throw new PlatformFailure('integrity');
        // Authenticated bounded JSON still rejects nonfinite/unsafe numeric schema content.
        const inspect = (v: unknown, depth = 0): void => {
          if (depth > 24) throw new PlatformFailure('integrity');
          if (typeof v === 'number' && !Number.isSafeInteger(v))
            throw new PlatformFailure('integrity');
          if (Array.isArray(v)) {
            if (v.length > 1000) throw new PlatformFailure('integrity');
            v.forEach((x) => inspect(x, depth + 1));
          } else if (v && typeof v === 'object')
            for (const [k, x] of Object.entries(v)) {
              if (k.endsWith('Minor') && x !== null) minor(x);
              inspect(x, depth + 1);
            }
        };
        inspect(b);
        return b as unknown as ReportFacts;
      },
      tx,
    );
    return {
      id: r.id,
      generation: r.generation,
      expiresAt: r.expires_at,
      ...facts,
    };
  }
  async get(p: SessionPrincipal, target: string) {
    id(target);
    return this.read(p, async (tx) => {
      const r = (
        await tx.query<RequestRow>(
          'SELECT * FROM app.report_requests WHERE user_id=$1 AND id=$2',
          [p.userId, target],
        )
      ).rows[0];
      if (!r) throw new PlatformFailure('not_found');
      return this.load(tx, p, r);
    });
  }
  async remove(p: SessionPrincipal, target: string) {
    id(target);
    return this.read(p, async (tx) => {
      const r = (
        await tx.query<RequestRow>(
          'SELECT * FROM app.report_requests WHERE user_id=$1 AND id=$2',
          [p.userId, target],
        )
      ).rows[0];
      if (!r) throw new PlatformFailure('not_found');
      await this.request(tx, p, r);
      await tx.query("SELECT set_config('forja.delete_report',$1,true)", [
        target,
      ]);
      await tx.query(
        'DELETE FROM app.report_snapshots WHERE user_id=$1 AND id=$2',
        [p.userId, target],
      );
    });
  }
  async list(p: SessionPrincipal, after: number, limit: number) {
    integer(after, 2147483647);
    integer(limit, 50, 1);
    return this.read(p, async (tx) => {
      const rows = (
        await tx.query<RequestRow>(
          'SELECT r.* FROM app.report_requests r JOIN app.report_snapshots s USING(user_id,id) WHERE r.user_id=$1 AND r.generation>$2 AND r.expires_at>$3 ORDER BY r.generation LIMIT $4',
          [p.userId, after, await this.now(tx), limit + 1],
        )
      ).rows;
      const chronicles = [];
      for (const r of rows.slice(0, limit)) {
        const v = await this.load(tx, p, r);
        chronicles.push({
          id: v.id,
          generation: v.generation,
          expiresAt: v.expiresAt,
          generatedAt: v.generatedAt,
          period: v.period,
          accountId: v.request.accountId,
          currency: v.finance.currency,
        });
      }
      return {
        chronicles,
        next: rows.length > limit ? rows[limit - 1]!.generation : null,
      };
    });
  }
  async generate(p: SessionPrincipal, key: string, raw: unknown) {
    idempotency(key);
    const c = command(raw),
      fp = hash(['report-command', 1, c]);
    const existing = await this.read(p, async (tx) => {
      const r = (
        await tx.query<RequestRow>(
          'SELECT * FROM app.report_requests WHERE user_id=$1 AND id=$2',
          [p.userId, key],
        )
      ).rows[0];
      if (!r) return null;
      if ((await this.request(tx, p, r)).fingerprint !== fp)
        throw new PlatformFailure('conflict');
      return this.load(tx, p, r);
    });
    if (existing) return existing;
    const identity = await this.identity.profile(p);
    let work: Awaited<ReturnType<WorkService['profile']>> | null = null;
    try {
      work = await this.work.profile(p);
    } catch (e) {
      if (!(e instanceof PlatformFailure && e.code === 'not_found')) throw e;
    }
    const active = await this.crypto.lifecycle.active(p.userId);
    await this.crypto.keys.withKey(active, p.binding, 'encrypt', (scope) =>
      this.finance.snapshot(p, async (u) => {
        scope.guard(u.tx);
        await this.cleanup(u.tx, p);
        const old = (
          await u.tx.query<RequestRow>(
            'SELECT * FROM app.report_requests WHERE user_id=$1 AND id=$2',
            [p.userId, key],
          )
        ).rows[0];
        if (old) {
          if ((await this.request(u.tx, p, old)).fingerprint !== fp)
            throw new PlatformFailure('conflict');
          await this.load(u.tx, p, old);
          return;
        }
        const generatedAt = await this.now(u.tx),
          period = periods(c, identity.timezone, generatedAt),
          budget = new ReadBudget();
        if (work && work.recordedAt > generatedAt)
          throw new PlatformFailure('unavailable');
        const finance = await this.finance.reportFacts(
            u,
            c.accountId,
            [period.previous, period.current],
            budget,
          ),
          settled = finance.metrics[1]!,
          previous = finance.metrics[0]!;
        const planning = await this.planning.reportFacts(
            u,
            c.accountId,
            finance.currency,
            period.current.start,
            period.current.end,
            budget,
          ),
          goal = await this.goals.reportFacts(u, c.accountId),
          game = await this.game.reportFacts(
            u.tx,
            p,
            period.current.start,
            period.current.end,
            goal
              ? {
                  goalId: goal.goalId,
                  accountId: c.accountId,
                  targetMinor: goal.targetMinor,
                  currency: goal.currency,
                }
              : null,
            budget,
          );
        const declared = work
          ? capacity(work.profile, {
              from: period.current.from,
              through: period.current.through,
            })
          : null;
        const workContext = declared
          ? {
              revision: work!.revision,
              recordedAt: work!.recordedAt,
              formulaVersion: declared.formulaVersion,
              currency: declared.currency,
              from: declared.from,
              through: declared.through,
              interpretation: 'declared-scenario-over-report-civil-labels',
              availableMinutesPerWeek: declared.availableMinutesPerWeek,
              totalMinor: declared.totalMinor,
              incomeMinusCapacityMinor:
                declared.totalMinor !== null &&
                declared.currency === finance.currency
                  ? minor(
                      (
                        minor(settled.incomeMinor) - minor(declared.totalMinor)
                      ).toString(),
                    ).toString()
                  : null,
            }
          : null;
        const { metrics: _, ...financeRef } = finance;
        void _;
        if (
          goal?.calculation &&
          goal.calculation.workRevision !== (work?.revision ?? null)
        )
          goal.calculation.stale = true;
        if (goal?.calculation && goal.calculation.asOf !== generatedAt)
          goal.calculation.stale = true;
        const facts = {
          reportVersion: 1 as const,
          request: c,
          period,
          generatedAt,
          locale: identity.locale,
          tzdb: process.versions.tz ?? 'unknown',
          identityRevision: identity.revision,
          finance: financeRef,
          settled,
          previous,
          comparisons: {
            income: comparison(settled.incomeMinor, previous.incomeMinor),
            expense: comparison(settled.expenseMinor, previous.expenseMinor),
            net: comparison(settled.netMinor, previous.netMinor),
          },
          planning,
          goal,
          work: workContext,
          game,
          reserve:
            game.reserveGoalId && goal
              ? {
                  goalId: goal.goalId,
                  goalRevision: goal.revision,
                  creditedMinor: goal.creditedMinor,
                  remainingMinor: goal.remainingMinor,
                  movement: null,
                }
              : null,
          inputsRead: budget.used,
        };
        currency(facts.finance.currency);
        const last = (
          await u.tx.query<{ generation: number; recorded_at: string }>(
            'SELECT generation,recorded_at FROM app.report_requests WHERE user_id=$1 ORDER BY generation DESC LIMIT 1',
            [p.userId],
          )
        ).rows[0];
        if (last && last.recorded_at > generatedAt)
          throw new PlatformFailure('unavailable');
        const generation = integer((last?.generation ?? 0) + 1, 2147483647, 1),
          expiresAt = new Date(
            Date.parse(generatedAt) + 7 * 86400000,
          ).toISOString();
        const receipt = await this.records.seal(
          scope,
          'reporting.request',
          key,
          1,
          [generation, generatedAt, expiresAt],
          { command: c, fingerprint: fp },
        );
        const payload = await this.records.seal(
          scope,
          'reporting.snapshot',
          key,
          1,
          [generatedAt, expiresAt],
          facts,
        );
        if (Buffer.byteLength(JSON.stringify(facts)) > 450000)
          throw new PlatformFailure('bounded_period');
        await u.tx.query(
          'INSERT INTO app.report_requests VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',
          [
            p.userId,
            key,
            generation,
            generatedAt,
            expiresAt,
            active.dekId,
            active.version,
            receipt,
          ],
        );
        await u.tx.query(
          'INSERT INTO app.report_snapshots VALUES($1,$2,1,$3,$4,$5,$6,$7)',
          [
            p.userId,
            key,
            generatedAt,
            expiresAt,
            active.dekId,
            active.version,
            payload,
          ],
        );
      }),
    );
    return this.get(p, key);
  }
  async alchemistFacts(p: SessionPrincipal, target: string) {
    const v = await this.get(p, target);
    return {
      reportVersion: v.reportVersion,
      period: {
        type: v.period.type,
        from: v.period.current.from,
        through: v.period.current.through,
        partial: v.period.partial,
      },
      currency: v.finance.currency,
      settled: v.settled,
      comparisons: v.comparisons,
      planning: {
        predictedIncomeMinor: v.planning.predictedIncomeMinor,
        receivableMinor: v.planning.receivableMinor,
        scheduledDebitMinor: v.planning.scheduledDebitMinor,
        payableMinor: v.planning.payableMinor,
        plannedNetMinor: v.planning.plannedNetMinor,
      },
      goal: v.goal
        ? {
            status: v.goal.status,
            remainingMinor: v.goal.remainingMinor,
            requiredIncome: v.goal.calculation?.conservative ?? null,
            requiredIncomeCurrency: v.goal.calculation?.currency ?? null,
            requiredIncomePeriod: v.goal.calculation
              ? {
                  from: v.goal.calculation.from,
                  through: v.goal.calculation.through,
                }
              : null,
            calculationStale: v.goal.calculation?.stale ?? null,
          }
        : null,
      work: v.work
        ? {
            currency: v.work.currency,
            totalMinor: v.work.totalMinor,
            incomeMinusCapacityMinor: v.work.incomeMinusCapacityMinor,
          }
        : null,
      game: {
        xpGained: v.game.xpGained,
        missionsCompleted: v.game.missionsCompleted,
        currentLevel: v.game.level,
      },
    };
  }
}
type ReportFacts = {
  reportVersion: 1;
  request: ReportCommand;
  period: ReturnType<typeof periods>;
  generatedAt: string;
  locale: string;
  tzdb: string;
  identityRevision: number;
  finance: Omit<Awaited<ReturnType<FinanceService['reportFacts']>>, 'metrics'>;
  settled: import('./model').Metrics;
  previous: import('./model').Metrics;
  comparisons: {
    income: ReturnType<typeof comparison>;
    expense: ReturnType<typeof comparison>;
    net: ReturnType<typeof comparison>;
  };
  planning: Awaited<ReturnType<PlanningService['reportFacts']>>;
  goal: Awaited<ReturnType<GoalsService['reportFacts']>>;
  work: {
    revision: number;
    recordedAt: string;
    formulaVersion: number;
    currency: string;
    from: string;
    through: string;
    interpretation: string;
    availableMinutesPerWeek: number;
    totalMinor: string | null;
    incomeMinusCapacityMinor: string | null;
  } | null;
  game: Awaited<ReturnType<GameService['reportFacts']>>;
  reserve: {
    goalId: string;
    goalRevision: number;
    creditedMinor: string;
    remainingMinor: string;
    movement: null;
  } | null;
  inputsRead: number;
};
