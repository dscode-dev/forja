import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SessionPrincipal } from '../platform/auth-control';
import { Database, Transaction } from '../platform/database';
import {
  EncryptedRecord,
  EncryptedRow,
  hash,
} from '../platform/encrypted-record';
import { CryptoPlatform } from '../platform/crypto/crypto-platform';
import {
  FinanceService,
  FinanceReadUnitOfWork,
} from '../finance/finance.service';
import { GoalsService } from '../planning/goals/goals.service';
import { PlanningService } from '../planning/planning.service';
import { WorkService } from '../work/work.service';
import { GameService } from '../game/game.service';
import { PlatformFailure } from '../platform/failure';
import { ReadBudget } from '../platform/read-budget';
import { object } from '../identity/validation';
import { id } from '../finance/validation';
import { StrategyFacts, strategyMinimize } from './strategist-model';
export interface StrategyIntent {
  goalId: string | null;
  focus: 'GENERAL' | 'GOAL' | 'RESERVE';
}
export interface SubjectRow extends EncryptedRow {
  id: string;
  recorded_at: string;
  expires_at: string;
}
export function strategyIntent(raw: unknown): StrategyIntent {
  const b = object(raw, ['goalId', 'focus']);
  if (!['GENERAL', 'GOAL', 'RESERVE'].includes(String(b['focus'])))
    throw new PlatformFailure('invalid');
  const goalId = b['goalId'] === null ? null : id(b['goalId']);
  if ((b['focus'] === 'GENERAL') !== (goalId === null))
    throw new PlatformFailure('invalid');
  return { goalId, focus: b['focus'] as StrategyIntent['focus'] };
}
@Injectable()
export class StrategySource {
  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoPlatform,
    private readonly records: EncryptedRecord,
    private readonly finance: FinanceService,
    private readonly goals: GoalsService,
    private readonly planning: PlanningService,
    private readonly work: WorkService,
    private readonly game: GameService,
  ) {}
  async facts(
    u: FinanceReadUnitOfWork,
    intent: StrategyIntent,
  ): Promise<StrategyFacts> {
    const at = (
        await u.tx.query<{ at: Date }>('SELECT clock_timestamp() AS at')
      ).rows[0]!.at,
      day = at.toISOString().slice(0, 10),
      start = day + 'T00:00:00.000Z',
      past = new Date(Date.parse(start) - 7 * 86400000).toISOString(),
      end = new Date(Date.parse(start) + 7 * 86400000).toISOString();
    const work = await this.work.strategyFacts(u.tx, u.principal, {
        from: day,
        through: new Date(Date.parse(start) + 6 * 86400000)
          .toISOString()
          .slice(0, 10),
      }),
      game = await this.game.strategyFacts(u, intent.goalId),
      budget = new ReadBudget();
    let goal: StrategyFacts['goal'] = null,
      pending: StrategyFacts['pending'] = null;
    if (intent.goalId) {
      const g = await this.goals.missionFacts(u, intent.goalId),
        a = await this.finance.requireAccount(u, g.accountId),
        v = await this.goals.reportFacts(u, g.accountId),
        movement = await this.finance.reportFacts(
          u,
          g.accountId,
          [{ start: past, end: start }],
          budget,
        ),
        m = movement.metrics[0]!;
      if (!v || v.goalId !== intent.goalId)
        throw new PlatformFailure('conflict');
      const q = await this.planning.reportFacts(
        u,
        g.accountId,
        g.currency,
        '1970-01-01T00:00:00.000Z',
        end,
        budget,
      );
      pending = {
        incomingMinor: (
          BigInt(q.predictedIncomeMinor) + BigInt(q.receivableMinor)
        ).toString(),
        outgoingMinor: (
          BigInt(q.scheduledDebitMinor) + BigInt(q.payableMinor)
        ).toString(),
        references: q.references,
      };
      goal = {
        id: intent.goalId,
        revision: g.revision,
        status: g.status,
        accountId: g.accountId,
        accountRevision: g.accountRevision,
        accountState: g.accountState,
        currency: g.currency,
        targetMinor: g.targetMinor,
        creditedMinor: g.creditedMinor,
        balanceMinor: a.value.balanceMinor,
        movementMinor:
          a.value.openedAt > past || m.baselineChangeMinor !== '0'
            ? null
            : m.netMinor,
        calculation: v.calculation,
        capacityInsufficient:
          v.calculation?.conservative.capacityComparison ===
          'ABOVE_DECLARED_CAPACITY',
        calculationStale:
          !!v.calculation &&
          (v.calculation.financeCursor !== u.seq ||
            v.calculation.workRevision !== work.revision ||
            v.calculation.goalRevision !== g.revision),
      };
    }
    return {
      day,
      financeCursor: u.seq,
      work,
      game,
      goal,
      pending,
      focus: intent.focus,
    };
  }
  async read(p: SessionPrincipal, intent: StrategyIntent, tx?: Transaction) {
    return this.finance.snapshot(p, (u) => this.facts(u, intent), tx, true);
  }
  async load(tx: Transaction, p: SessionPrincipal, target: string) {
    const row = (
      await tx.query<SubjectRow>(
        'SELECT * FROM app.ai_strategy_subjects WHERE user_id=$1 AND id=$2',
        [p.userId, id(target)],
      )
    ).rows[0];
    if (!row) throw new PlatformFailure('not_found');
    const data = await this.records.open(
      p,
      row,
      'ai.strategy.subject',
      row.id,
      [row.recorded_at, row.expires_at],
      (raw) => {
        const b = object(raw, ['intent', 'sourceFingerprint', 'references']);
        if (
          typeof b['sourceFingerprint'] !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(b['sourceFingerprint'])
        )
          throw new PlatformFailure('integrity');
        const r = object(b['references'], [
          'goalRevision',
          'financeCursor',
          'workRevision',
          'catalogueVersion',
          'day',
          'gameAwardSequence',
        ]);
        for (const k of ['financeCursor', 'workRevision', 'gameAwardSequence'])
          if (!Number.isSafeInteger(r[k]) || Number(r[k]) < 0)
            throw new PlatformFailure('integrity');
        if (
          r['catalogueVersion'] !== 1 ||
          typeof r['day'] !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/u.test(r['day']) ||
          (r['goalRevision'] !== null &&
            (!Number.isSafeInteger(r['goalRevision']) ||
              Number(r['goalRevision']) < 1))
        )
          throw new PlatformFailure('integrity');
        return {
          references: {
            goalRevision: r['goalRevision'] as number | null,
            financeCursor: r['financeCursor'] as number,
            workRevision: r['workRevision'] as number,
            catalogueVersion: 1,
            day: r['day'],
            gameAwardSequence: r['gameAwardSequence'] as number,
          },
          intent: strategyIntent(b['intent']),
          sourceFingerprint: b['sourceFingerprint'],
        };
      },
      tx,
    );
    const now = (
      await tx.query<{ at: Date }>('SELECT clock_timestamp() AS at')
    ).rows[0]!.at.toISOString();
    if (row.expires_at <= now) throw new PlatformFailure('not_found');
    return { row, data };
  }
  async reference(tx: Transaction, p: SessionPrincipal, target: string) {
    const v = await this.load(tx, p, target);
    return { generation: 1, expiresAt: v.row.expires_at, reportVersion: 1 };
  }
  async prepared(p: SessionPrincipal, target: string, tx?: Transaction) {
    return this.finance.snapshot(
      p,
      async (u) => {
        const v = await this.load(u.tx, p, target),
          facts = await this.facts(u, v.data.intent),
          fp = hash(['strategist-source', 1, facts]);
        return {
          context: strategyMinimize(facts),
          sourceFingerprint: fp,
          inputFingerprint: hash([
            'strategist-context',
            1,
            strategyMinimize(facts),
          ]),
          stale: fp !== v.data.sourceFingerprint,
        };
      },
      tx,
      true,
    );
  }
  async evidence(
    p: SessionPrincipal,
    target: string,
    transaction?: Transaction,
  ) {
    return this.finance.snapshot(
      p,
      async (u) => {
        const v = await this.load(u.tx, p, target),
          f = await this.facts(u, v.data.intent),
          stale =
            hash(['strategist-source', 1, f]) !== v.data.sourceFingerprint;
        return {
          stale,
          evidence: {
            scope: 'USER_SELECTED_FOCUS',
            day: f.day,
            currency: f.goal?.currency ?? null,
            settledMinor: f.goal?.balanceMinor ?? null,
            accountMovementMinor: f.goal?.movementMinor ?? null,
            goalTargetMinor: f.goal?.targetMinor ?? null,
            goalRemainingMinor: f.goal
              ? (
                  BigInt(f.goal.targetMinor) - BigInt(f.goal.creditedMinor)
                ).toString()
              : null,
            pendingOutgoingMinor: f.pending?.outgoingMinor ?? null,
            pendingIncomingMinor: f.pending?.incomingMinor ?? null,
            expenseBaseline: null,
            coverageDays: null,
            idealReserveTarget: null,
          },
          intent: v.data.intent,
        };
      },
      transaction,
      true,
    );
  }
  async select(p: SessionPrincipal, intent: StrategyIntent, create: boolean) {
    intent = strategyIntent(intent);
    const active = await this.crypto.lifecycle.active(p.userId);
    return this.crypto.keys.withKey(active, p.binding, 'encrypt', (scope) =>
      this.finance.snapshot(
        p,
        async (u) => {
          scope.guard(u.tx);
          const f = await this.facts(u, intent),
            fp = hash(['strategist-source', 1, f]);
          // Bound retained subjects; do not silently truncate a cache/input search.
          const rows = (
            await u.tx.query<SubjectRow>(
              `SELECT * FROM app.ai_strategy_subjects WHERE user_id=$1 AND expires_at>to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ORDER BY recorded_at DESC LIMIT 101`,
              [p.userId],
            )
          ).rows;
          if (rows.length > 100) throw new PlatformFailure('bounded_period');
          let latest: string | null = null;
          for (const r of rows) {
            const v = await this.load(u.tx, p, r.id);
            if (hash(v.data.intent) === hash(intent)) {
              latest ??= r.id;
              if (v.data.sourceFingerprint === fp) return r.id;
            }
          }
          if (!create) return latest;
          if (!strategyMinimize(f)) return null;
          const at = (
              await u.tx.query<{ at: Date }>('SELECT clock_timestamp() AS at')
            ).rows[0]!.at.toISOString(),
            expiresAt = new Date(Date.parse(at) + 7 * 86400000).toISOString(),
            target = randomUUID();
          const payload = await this.records.seal(
            scope,
            'ai.strategy.subject',
            target,
            1,
            [at, expiresAt],
            {
              intent,
              sourceFingerprint: fp,
              references: {
                goalRevision: f.goal?.revision ?? null,
                financeCursor: f.financeCursor,
                workRevision: f.work.revision,
                catalogueVersion: 1,
                day: f.day,
                gameAwardSequence: f.game.awardSequence,
              },
            },
          );
          await u.tx.query(
            'INSERT INTO app.ai_strategy_subjects VALUES($1,$2,1,$3,$4,$5,$6,$7)',
            [
              p.userId,
              target,
              at,
              expiresAt,
              scope.identity.dekId,
              scope.identity.version,
              payload,
            ],
          );
          return target;
        },
        undefined,
        true,
      ),
    );
  }
}
