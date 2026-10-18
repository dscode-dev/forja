import { Injectable } from '@nestjs/common';
import { Database, Transaction } from '../platform/database';
import { EncryptedRecord, EncryptedRow } from '../platform/encrypted-record';
import { CryptoPlatform } from '../platform/crypto/crypto-platform';
import { SessionPrincipal } from '../platform/auth-control';
import { IdentityService } from '../identity/identity.service';
import { GameService } from '../game/game.service';
import {
  FinanceService,
  FinanceReadUnitOfWork,
} from '../finance/finance.service';
import { PlatformFailure } from '../platform/failure';
import { object } from '../identity/validation';
import { id, idempotency } from '../finance/validation';
import { KeyScope } from '../platform/crypto/key-service';
import { AiService, AiView } from './ai.service';
import { StrategySource, StrategyIntent } from './strategy-source';
import { strategyRender } from './strategist-model';
interface DecisionRow extends EncryptedRow {
  execution_id: string;
  recorded_at: string;
}
@Injectable()
export class StrategistService {
  constructor(
    private readonly ai: AiService,
    private readonly db: Database,
    private readonly identity: IdentityService,
    private readonly source: StrategySource,
    private readonly game: GameService,
    private readonly finance: FinanceService,

    private readonly crypto: CryptoPlatform,
    private readonly records: EncryptedRecord,
  ) {}
  private async decision(tx: Transaction, p: SessionPrincipal, target: string) {
    const r = (
      await tx.query<DecisionRow>(
        'SELECT * FROM app.ai_strategy_decisions WHERE user_id=$1 AND execution_id=$2',
        [p.userId, target],
      )
    ).rows[0];
    if (!r) return null;
    return this.records.open(
      p,
      r,
      'ai.strategy.decision',
      target,
      [r.recorded_at],
      (raw) => {
        const b = object(raw, ['action', 'missionId']);
        if (b['action'] !== 'ACCEPTED' && b['action'] !== 'DISMISSED')
          throw new PlatformFailure('integrity');
        const missionId = b['missionId'] === null ? null : id(b['missionId']);
        if ((b['action'] === 'ACCEPTED') !== (missionId !== null))
          throw new PlatformFailure('integrity');
        return { action: b['action'] as 'ACCEPTED' | 'DISMISSED', missionId };
      },
      tx,
    );
  }
  private async readDecision(p: SessionPrincipal, target: string) {
    await this.identity.assertOwner(p, p.userId);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [p.userId]);
      tx.beforeCommit(() => this.identity.assertOwner(p, p.userId));
      return this.decision(tx, p, target);
    });
  }
  private async record(
    tx: Transaction,
    scope: KeyScope,
    target: string,
    action: 'ACCEPTED' | 'DISMISSED',
    missionId: string | null,
  ) {
    const at = (
        await tx.query<{ at: Date }>('SELECT clock_timestamp() AS at')
      ).rows[0]!.at.toISOString(),
      payload = await this.records.seal(
        scope,
        'ai.strategy.decision',
        target,
        1,
        [at],
        { action, missionId },
      );
    await tx.query(
      'INSERT INTO app.ai_strategy_decisions VALUES($1,$2,1,$3,$4,$5,$6)',
      [
        scope.identity.userId,
        target,
        at,
        scope.identity.dekId,
        scope.identity.version,
        payload,
      ],
    );
  }
  private async view(p: SessionPrincipal, v: AiView, consentRevision: number) {
    return this.finance.snapshot(
      p,
      async (u) => {
        const consent = await this.ai.preference(u.tx, p);
        if (!consent.enabled) return this.empty('DISABLED');
        if (consent.revision !== consentRevision)
          return this.empty('CANCELLED');
        const decision = v.executionId
          ? await this.decision(u.tx, p, v.executionId)
          : null;
        const { reportId, narrative, ...rest } = v,
          source = await this.source.evidence(p, reportId, u.tx);
        const valid = v.state === 'SUCCEEDED' && !source.stale,
          n =
            valid && narrative?.kind === 'AI_STRATEGY'
              ? (narrative as ReturnType<typeof strategyRender>)
              : null;
        return {
          ...rest,
          state: source.stale ? 'STALE' : v.state,
          strategyId: reportId || null,
          narrative: n,
          decision,
          evidence: source.evidence,
          proposal:
            n?.proposal && !decision
              ? {
                  ...this.game.proposalDefinition(n.proposal.template),
                  goalId:
                    n.proposal.template === 'WORK_PROFILE'
                      ? null
                      : source.intent.goalId,
                  rationale: n.proposal.rationale,
                }
              : null,
        };
      },
      undefined,
      true,
    );
  }
  private empty(
    state: 'DISABLED' | 'NO_ACTION' | 'ABSENT' | 'UNAVAILABLE' | 'CANCELLED',
  ) {
    return {
      state,
      executionId: null,
      strategyId: null,
      promptVersion: 1,
      createdAt: null,
      failure: null,
      narrative: null,
      cached: false,
      decision: null,
      evidence: null,
      proposal: null,
    };
  }
  async get(p: SessionPrincipal, intent: StrategyIntent) {
    const pref = await this.ai.preferences(p);
    if (!pref.enabled) return this.empty('DISABLED');
    const target = await this.source.select(p, intent, false);
    if (!target)
      return this.empty(pref.providerAvailable ? 'ABSENT' : 'UNAVAILABLE');
    return this.view(
      p,
      await this.ai.get(p, target, 'ESTRATEGISTA'),
      pref.revision,
    );
  }
  async request(
    p: SessionPrincipal,
    intent: StrategyIntent,
    key: string,
    retryOf: string | null,
  ) {
    idempotency(key);
    if (retryOf !== null) id(retryOf);
    const pref = await this.ai.preferences(p);
    if (!pref.enabled) return this.empty('DISABLED');
    const target = await this.source.select(p, intent, true);
    if (!target) return this.empty('NO_ACTION');
    return this.view(
      p,
      await this.ai.request(p, target, key, retryOf, 'ESTRATEGISTA'),
      pref.revision,
    );
  }
  async proposals(p: SessionPrincipal, intent: StrategyIntent) {
    const v = await this.get(p, intent);
    return {
      state: v.state,
      executionId: v.executionId,
      proposal: v.state === 'SUCCEEDED' && !v.decision ? v.proposal : null,
    };
  }
  async dismiss(p: SessionPrincipal, target: string) {
    id(target);
    const key = await this.crypto.lifecycle.active(p.userId);
    return this.crypto.keys.withKey(key, p.binding, 'encrypt', (scope) =>
      this.finance.snapshot(
        p,
        async (u) => {
          scope.guard(u.tx);
          const prior = await this.decision(u.tx, p, target);
          if (prior) {
            if (prior.action !== 'DISMISSED')
              throw new PlatformFailure('conflict');
            return prior;
          }
          await this.ai.adoptable(u.tx, p, target, false);
          await this.record(u.tx, scope, target, 'DISMISSED', null);
          return { action: 'DISMISSED', missionId: null };
        },
        undefined,
        true,
      ),
    );
  }
  async accept(p: SessionPrincipal, target: string) {
    try {
      return await this.acceptOnce(p, target);
    } catch (e) {
      if (e instanceof PlatformFailure && e.code === 'conflict') {
        const prior = await this.readDecision(p, target);
        if (prior?.action === 'ACCEPTED')
          return this.game.get(p, prior.missionId!);
      }
      throw e;
    }
  }
  private async acceptOnce(p: SessionPrincipal, target: string) {
    id(target);
    const prior = await this.readDecision(p, target);
    if (prior) {
      if (prior.action !== 'ACCEPTED') throw new PlatformFailure('conflict');
      return this.game.get(p, prior.missionId!);
    }
    // Preliminary lookup selects a bounded command; Game rechecks everything under its own transaction.
    const prepared = await this.ai.strategyCommand(p, target),
      proposal = prepared.proposal;
    if (!proposal) throw new PlatformFailure('conflict');
    const goalId =
      proposal.template === 'WORK_PROFILE' ? null : prepared.intent.goalId;
    const revision = goalId ? prepared.goalRevision : null;
    return this.game.assign(p, target, proposal.template, goalId, revision, {
      validate: async (u: FinanceReadUnitOfWork) => {
        const existing = await this.decision(u.tx, p, target);
        if (existing) {
          if (existing.action !== 'ACCEPTED' || existing.missionId !== target)
            throw new PlatformFailure('conflict');
          return;
        }
        const current = await this.ai.adoptable(u.tx, p, target);
        if (
          current.proposal?.template !== proposal.template ||
          current.intent.goalId !== prepared.intent.goalId
        )
          throw new PlatformFailure('conflict');
      },
      record: async (tx, scope, missionId) => {
        if (!(await this.decision(tx, p, target)))
          await this.record(tx, scope, target, 'ACCEPTED', missionId);
      },
    });
  }
}
