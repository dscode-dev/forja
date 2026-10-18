import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Database, Transaction } from '../platform/database';
import {
  EncryptedRecord,
  EncryptedRow,
  hash,
} from '../platform/encrypted-record';
import { CryptoPlatform } from '../platform/crypto/crypto-platform';
import { KeyScope } from '../platform/crypto/key-service';
import { PrivacyErasure } from '../platform/privacy-erasure';
import { SafeLogger } from '../platform/safe-logger';
import { SessionPrincipal } from '../platform/auth-control';
import { IdentityService } from '../identity/identity.service';
import { ReportingService } from '../reporting/reporting.service';
import { PlatformFailure } from '../platform/failure';
import { id, idempotency } from '../finance/validation';
import { integer } from '../work/model';
import { object } from '../identity/validation';
import {
  AI_PROVIDER,
  AiProvider,
  MODEL,
  ProviderResult,
  ProviderContext,
} from './provider';
import {
  POLICY,
  PROMPT_VERSION,
  CONFIG_VERSION,
  AiFailure,
  Failure,
  Output,
  minimize,
  output,
  render,
} from './model';
import {
  STRATEGY_CONFIG,
  StrategyOutput,
  strategyOutput,
  strategyRender,
} from './strategist-model';
import { StrategySource } from './strategy-source';
type Agent = 'ALQUIMISTA' | 'ESTRATEGISTA';
type AiOutput = Output | StrategyOutput;
interface PreferenceRow extends EncryptedRow {
  enabled: boolean;
  policy: string;
  recorded_at: string;
}
interface ExecutionRow extends EncryptedRow {
  id: string;
  report_id: string;
  report_generation: number;
  consent_revision: number;
  prompt_version: number;
  config_version: string;
  attempt: number;
  state: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  started_at: string;
  updated_at: string;
  deadline: string;
  expires_at: string;
}
interface ReceiptRow extends EncryptedRow {
  id: string;
  execution_id: string;
  dispatched_at: string | null;
  recorded_at: string;
}
interface Data {
  intentFingerprint: string;
  inputFingerprint: string;
  sourceFingerprint: string;
  result: AiOutput | null;
  failure: Failure | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    requestId: string | null;
  } | null;
}
interface Loaded {
  row: ExecutionRow;
  data: Data;
}
export type AiState =
  | ExecutionRow['state']
  | 'DISABLED'
  | 'UNAVAILABLE'
  | 'ABSENT'
  | 'EXPIRED'
  | 'INSUFFICIENT_CONTEXT'
  | 'THROTTLED'
  | 'STALE';
export interface AiView {
  state: AiState;
  executionId: string | null;
  reportId: string;
  promptVersion: number;
  model: string;
  createdAt: string | null;
  failure: Failure | null;
  narrative:
    ReturnType<typeof render> | ReturnType<typeof strategyRender> | null;
  cached: boolean;
}
const failures: Failure[] = [
  'CONFIGURATION',
  'TIMEOUT',
  'UNAVAILABLE',
  'RATE_LIMIT',
  'REFUSAL',
  'INVALID_OUTPUT',
  'OUTCOME_UNKNOWN',
  'CONSENT_REVOKED',
  'SOURCE_EXPIRED',
  'INSUFFICIENT_CONTEXT',
  'THROTTLED',
  'CANCELLED',
];
@Injectable()
export class AiService {
  constructor(
    private readonly db: Database,
    private readonly records: EncryptedRecord,
    private readonly crypto: CryptoPlatform,
    private readonly identity: IdentityService,
    private readonly reporting: ReportingService,
    private readonly strategies: StrategySource,
    private readonly logger: SafeLogger,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    erasure: PrivacyErasure,
  ) {
    erasure.register('ai', async (tx, owner) => {
      for (const table of [
        'ai_request_receipts',
        'ai_executions',
        'ai_strategy_decisions',
        'ai_strategy_subjects',
        'ai_preferences',
        'ai_preference_history',
      ])
        await tx.query(`DELETE FROM app.${table} WHERE user_id=$1`, [owner]);
    });
  }
  private active = new Map<
    string,
    { owner: string; controller: AbortController }
  >();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private sweepCursor = '00000000-0000-0000-0000-000000000000';
  private sweeping = false;
  onModuleInit() {
    this.sweepTimer = setInterval(() => {
      void this.sweepExpired().catch(() =>
        this.logger.event('ai.retention', 'unavailable'),
      );
    }, 60000);
    this.sweepTimer.unref();
  }
  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const v of this.active.values()) v.controller.abort();
  }
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
      for (const o of owners)
        await this.db.transaction(async (tx) => {
          await tx.query("SELECT set_config('forja.user_id',$1,true)", [o.id]);
          await tx.query(
            'SELECT id FROM app.users WHERE id=$1 FOR NO KEY UPDATE',
            [o.id],
          );
          await this.cleanup(tx, o.id);
        });
      this.sweepCursor =
        owners.length === 100
          ? owners[99]!.id
          : '00000000-0000-0000-0000-000000000000';
    } finally {
      this.sweeping = false;
    }
  }
  async ready() {
    try {
      await this.db.query(
        'SELECT p.revision,h.revision,e.id,r.id FROM app.ai_preferences p CROSS JOIN app.ai_preference_history h CROSS JOIN app.ai_executions e CROSS JOIN app.ai_request_receipts r LIMIT 0',
      );
      return true;
    } catch {
      return false;
    }
  }
  private async now(tx: Transaction) {
    return (
      await tx.query<{ at: Date }>('SELECT clock_timestamp() AS at')
    ).rows[0]!.at.toISOString();
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
  private async cleanup(tx: Transaction, owner: string) {
    await tx.query(
      'DELETE FROM app.ai_executions WHERE user_id=$1 AND id IN(SELECT id FROM app.ai_executions WHERE user_id=$1 AND expires_at<=to_char(clock_timestamp() AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') ORDER BY expires_at LIMIT 100)',
      [owner],
    );
    await tx.query(
      'DELETE FROM app.ai_strategy_subjects WHERE user_id=$1 AND expires_at<=to_char(clock_timestamp() AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\')',
      [owner],
    );
  }
  private async read<T>(
    p: SessionPrincipal,
    fn: (tx: Transaction) => Promise<T>,
  ) {
    await this.identity.assertOwner(p, p.userId);
    return this.db.transaction(async (tx) => {
      await this.owner(tx, p);
      return fn(tx);
    });
  }
  private async command<T>(
    p: SessionPrincipal,
    fn: (tx: Transaction, scope: KeyScope) => Promise<T>,
  ) {
    await this.identity.assertOwner(p, p.userId);
    const key = await this.crypto.lifecycle.active(p.userId);
    return this.crypto.keys.withKey(key, p.binding, 'encrypt', (scope) =>
      this.crypto.keys.transaction(scope, async (tx) => {
        await this.owner(tx, p);
        await this.cleanup(tx, p.userId);
        return fn(tx, scope);
      }),
    );
  }
  async preference(tx: Transaction, p: SessionPrincipal) {
    const heads = (
      await tx.query<{ revision: number | null; latest: number | null }>(
        'SELECT (SELECT revision FROM app.ai_preferences WHERE user_id=$1) AS revision,(SELECT max(revision) FROM app.ai_preference_history WHERE user_id=$1) AS latest',
        [p.userId],
      )
    ).rows[0]!;
    if (heads.revision !== heads.latest) throw new PlatformFailure('integrity');
    if (!heads.revision)
      return { enabled: false, revision: 0, policyVersion: POLICY };
    const row = (
      await tx.query<PreferenceRow>(
        'SELECT * FROM app.ai_preference_history WHERE user_id=$1 AND revision=$2',
        [p.userId, heads.revision],
      )
    ).rows[0];
    if (!row) throw new PlatformFailure('integrity');
    await this.records.open(
      p,
      row,
      'ai.consent',
      p.userId,
      [row.enabled ? 1 : 0, row.policy, row.recorded_at],
      (raw) => {
        const b = object(raw, ['enabled', 'policy']);
        if (
          b['enabled'] !== row.enabled ||
          b['policy'] !== POLICY ||
          row.policy !== POLICY
        )
          throw new PlatformFailure('integrity');
        return true;
      },
      tx,
    );
    return {
      enabled: row.enabled,
      revision: row.revision,
      policyVersion: POLICY,
    };
  }
  async preferences(p: SessionPrincipal) {
    return {
      ...(await this.read(p, (tx) => this.preference(tx, p))),
      providerAvailable: this.provider.available(),
      disclosure:
        'IA opcional. Alquimista e Estrategista usam somente sinais minimizados do relatório ou foco escolhido, sem valores exatos, datas, nomes ou identificadores. Um modelo OpenAI seleciona e organiza observações e propostas opcionais de missões com texto revisado. Atribuir uma missão exige sua confirmação; regras e recompensas pertencem ao sistema. Pode haver limitações; os fatos e valores permanecem no relatório determinístico. Desativar impede novas análises, mas não desfaz dados já enviados.',
    };
  }
  async setPreferences(
    p: SessionPrincipal,
    revision: number,
    enabled: boolean,
    policy: string,
  ) {
    integer(revision, 2147483646);
    if (typeof enabled !== 'boolean' || policy !== POLICY)
      throw new PlatformFailure('invalid');
    await this.command(p, async (tx, scope) => {
      const current = await this.preference(tx, p);
      if (current.revision !== revision) throw new PlatformFailure('conflict');
      const at = await this.now(tx),
        next = revision + 1;
      const last = (
        await tx.query<{ recorded_at: string }>(
          'SELECT recorded_at FROM app.ai_preference_history WHERE user_id=$1 ORDER BY revision DESC LIMIT 1',
          [p.userId],
        )
      ).rows[0];
      if (last && last.recorded_at > at)
        throw new PlatformFailure('unavailable');
      const payload = await this.records.seal(
        scope,
        'ai.consent',
        p.userId,
        next,
        [enabled ? 1 : 0, POLICY, at],
        { enabled, policy: POLICY },
      );
      await tx.query(
        'INSERT INTO app.ai_preference_history VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          p.userId,
          next,
          enabled,
          POLICY,
          at,
          scope.identity.dekId,
          scope.identity.version,
          payload,
        ],
      );
      await tx.query(
        'INSERT INTO app.ai_preferences VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision',
        [p.userId, next],
      );
      if (!enabled) {
        const rows = (
          await tx.query<ExecutionRow>(
            "SELECT * FROM app.ai_executions WHERE user_id=$1 AND state='RUNNING' LIMIT 11",
            [p.userId],
          )
        ).rows;
        if (rows.length > 10) throw new PlatformFailure('integrity');
        for (const r of rows) {
          const m = await this.load(tx, p, r);
          await this.terminal(
            tx,
            scope,
            m,
            'CANCELLED',
            null,
            'CONSENT_REVOKED',
            null,
            at,
          );
        }
      }
    });
    if (!enabled)
      for (const a of this.active.values())
        if (a.owner === p.userId) a.controller.abort();
    return this.preferences(p);
  }
  private meta(r: ExecutionRow) {
    return [
      r.report_id,
      r.report_generation,
      r.consent_revision,
      r.prompt_version,
      r.config_version,
      r.attempt,
      r.state,
      r.started_at,
      r.updated_at,
      r.deadline,
      r.expires_at,
    ];
  }
  private async load(
    tx: Transaction,
    p: SessionPrincipal,
    row: ExecutionRow,
  ): Promise<Loaded> {
    const data = await this.records.open(
      p,
      row,
      'ai.execution',
      row.id,
      this.meta(row),
      (raw) => {
        const b = object(raw, [
          'intentFingerprint',
          'inputFingerprint',
          'sourceFingerprint',
          'result',
          'failure',
          'usage',
        ]);
        for (const k of [
          'intentFingerprint',
          'inputFingerprint',
          'sourceFingerprint',
        ])
          if (
            typeof b[k] !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(b[k] as string)
          )
            throw new PlatformFailure('integrity');
        const failure = b['failure'];
        if (failure !== null && !failures.includes(failure as Failure))
          throw new PlatformFailure('integrity');
        const result =
          b['result'] === null
            ? null
            : this.parseOutput(
                b['result'],
                null,
                row.config_version === STRATEGY_CONFIG
                  ? 'ESTRATEGISTA'
                  : 'ALQUIMISTA',
              );
        if (
          (row.state === 'SUCCEEDED') !== (result !== null) ||
          (row.state === 'RUNNING' && failure !== null) ||
          (['FAILED', 'CANCELLED'].includes(row.state) && failure === null)
        )
          throw new PlatformFailure('integrity');
        let usage: Data['usage'] = null;
        if (b['usage'] !== null) {
          const u = object(b['usage'], [
            'inputTokens',
            'outputTokens',
            'durationMs',
            'requestId',
          ]);
          usage = {
            inputTokens: integer(u['inputTokens'], 6000),
            outputTokens: integer(u['outputTokens'], 900),
            durationMs: integer(u['durationMs'], 60000),
            requestId: u['requestId'] === null ? null : String(u['requestId']),
          };
          if (
            usage.requestId !== null &&
            !/^req_[A-Za-z0-9_-]{1,120}$/u.test(usage.requestId)
          )
            throw new PlatformFailure('integrity');
        }
        return {
          intentFingerprint: b['intentFingerprint'] as string,
          inputFingerprint: b['inputFingerprint'] as string,
          sourceFingerprint: b['sourceFingerprint'] as string,
          result,
          failure: failure as Failure | null,
          usage,
        };
      },
      tx,
    );
    if (
      row.updated_at < row.started_at ||
      row.expires_at <= row.started_at ||
      Date.parse(row.deadline) - Date.parse(row.started_at) !== 30000
    )
      throw new PlatformFailure('integrity');
    return { row, data };
  }
  private async terminal(
    tx: Transaction,
    scope: KeyScope,
    m: Loaded,
    state: 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
    result: AiOutput | null,
    failure: Failure | null,
    usage: Data['usage'],
    at: string,
  ): Promise<Loaded> {
    if (m.row.state !== 'RUNNING') return m;
    if (at < m.row.updated_at) throw new PlatformFailure('unavailable');
    const row = { ...m.row, state, revision: 2, updated_at: at },
      data = { ...m.data, result, failure, usage };
    const payload = await this.records.seal(
      scope,
      'ai.execution',
      row.id,
      2,
      this.meta(row),
      data,
    );
    const r = await tx.query(
      "UPDATE app.ai_executions SET state=$3,revision=2,updated_at=$4,dek_id=$5,dek_version=$6,payload=$7 WHERE user_id=$1 AND id=$2 AND state='RUNNING' AND revision=1",
      [
        row.user_id,
        row.id,
        state,
        at,
        scope.identity.dekId,
        scope.identity.version,
        payload,
      ],
    );
    if (r.rowCount !== 1) throw new PlatformFailure('conflict');
    return { row, data };
  }
  private async expire(
    tx: Transaction,
    scope: KeyScope,
    m: Loaded,
    at: string,
  ) {
    return m.row.state === 'RUNNING' && m.row.deadline <= at
      ? this.terminal(tx, scope, m, 'FAILED', null, 'OUTCOME_UNKNOWN', null, at)
      : m;
  }
  private view(
    state: AiState,
    reportId: string,
    m: Loaded | null = null,
    cached = false,
    c: ProviderContext | null = null,
  ): AiView {
    return {
      state,
      executionId: m?.row.id ?? null,
      reportId,
      promptVersion: PROMPT_VERSION,
      model: MODEL,
      createdAt: m?.row.started_at ?? null,
      failure: m?.data.failure ?? null,
      narrative:
        state === 'SUCCEEDED' && m?.data.result && c
          ? c.role === 'ESTRATEGISTA'
            ? strategyRender(strategyOutput(m.data.result, c))
            : render(output(m.data.result, c))
          : null,
      cached,
    };
  }
  private async receipt(
    tx: Transaction,
    p: SessionPrincipal,
    key: string,
    fp: string,
  ) {
    const r = (
      await tx.query<ReceiptRow>(
        'SELECT * FROM app.ai_request_receipts WHERE user_id=$1 AND id=$2',
        [p.userId, key],
      )
    ).rows[0];
    if (!r) return null;
    const priorFp = await this.records.open(
      p,
      r,
      'ai.receipt',
      key,
      [r.execution_id, r.dispatched_at, r.recorded_at],
      (raw) => {
        const b = object(raw, ['intentFingerprint']);
        if (
          typeof b['intentFingerprint'] !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(b['intentFingerprint'])
        )
          throw new PlatformFailure('integrity');
        return b['intentFingerprint'];
      },
      tx,
    );
    if (priorFp !== fp) throw new PlatformFailure('conflict');
    return r.execution_id;
  }
  private async saveReceipt(
    tx: Transaction,
    scope: KeyScope,
    key: string,
    executionId: string,
    fp: string,
    at: string,
    dispatched: boolean,
  ) {
    const sent = dispatched ? at : null,
      payload = await this.records.seal(
        scope,
        'ai.receipt',
        key,
        1,
        [executionId, sent, at],
        { intentFingerprint: fp },
      );
    await tx.query(
      'INSERT INTO app.ai_request_receipts VALUES($1,$2,$3,$4,1,$5,$6,$7,$8)',
      [
        scope.identity.userId,
        key,
        executionId,
        sent,
        at,
        scope.identity.dekId,
        scope.identity.version,
        payload,
      ],
    );
  }
  private parseOutput(
    raw: unknown,
    c: ProviderContext | null,
    agent: Agent,
  ): AiOutput {
    return agent === 'ESTRATEGISTA'
      ? strategyOutput(raw, c?.role === 'ESTRATEGISTA' ? c : null)
      : output(raw, c?.role === 'ALQUIMISTA' ? c : null);
  }
  private reference(
    tx: Transaction,
    p: SessionPrincipal,
    target: string,
    agent: Agent,
  ) {
    return agent === 'ESTRATEGISTA'
      ? this.strategies.reference(tx, p, target)
      : this.reporting.aiReference(tx, p, target);
  }
  private async prepared(p: SessionPrincipal, reportId: string, agent: Agent) {
    if (agent === 'ESTRATEGISTA') return this.strategies.prepared(p, reportId);
    const facts = await this.reporting.alchemistFacts(p, reportId),
      c = minimize(facts);
    return {
      context: c,
      inputFingerprint: hash(['alquimista-context', 1, c]),
      sourceFingerprint: hash(['alquimista-source', 1, facts]),
      stale: false,
    };
  }
  async get(
    p: SessionPrincipal,
    reportId: string,
    agent: Agent = 'ALQUIMISTA',
  ): Promise<AiView> {
    id(reportId);
    const pref = await this.read(p, async (tx) => {
      await this.reference(tx, p, reportId, agent);
      return this.preference(tx, p);
    });
    if (!pref.enabled) return this.view('DISABLED', reportId);
    const prepared = await this.prepared(p, reportId, agent);

    return this.command(p, async (tx, scope) => {
      await this.reference(tx, p, reportId, agent);

      const consent = await this.preference(tx, p);
      if (!consent.enabled) return this.view('DISABLED', reportId);
      const row = (
        await tx.query<ExecutionRow>(
          'SELECT * FROM app.ai_executions WHERE user_id=$1 AND report_id=$2 AND consent_revision=$3 AND prompt_version=$4 AND config_version=$5 ORDER BY attempt DESC LIMIT 1',
          [
            p.userId,
            reportId,
            consent.revision,
            PROMPT_VERSION,
            agent === 'ESTRATEGISTA' ? STRATEGY_CONFIG : CONFIG_VERSION,
          ],
        )
      ).rows[0];
      if (!row)
        return this.view(
          !prepared.context
            ? 'INSUFFICIENT_CONTEXT'
            : this.provider.available()
              ? 'ABSENT'
              : 'UNAVAILABLE',
          reportId,
        );
      const m = await this.expire(
        tx,
        scope,
        await this.load(tx, p, row),
        await this.now(tx),
      );
      if (
        prepared.stale ||
        (agent === 'ESTRATEGISTA' &&
          (await this.strategies.prepared(p, reportId, tx)).stale)
      )
        return this.view('STALE', reportId, m, true);
      if (
        m.data.inputFingerprint !== prepared.inputFingerprint ||
        m.data.sourceFingerprint !== prepared.sourceFingerprint
      )
        throw new PlatformFailure('integrity');
      return this.view(m.row.state, reportId, m, true, prepared.context);
    });
  }
  async status(p: SessionPrincipal, target: string) {
    id(target);
    const r = await this.read(
      p,
      async (tx) =>
        (
          await tx.query<ExecutionRow>(
            'SELECT * FROM app.ai_executions WHERE user_id=$1 AND id=$2',
            [p.userId, target],
          )
        ).rows[0],
    );
    if (!r) throw new PlatformFailure('not_found');
    const agent: Agent =
      r.config_version === STRATEGY_CONFIG ? 'ESTRATEGISTA' : 'ALQUIMISTA';
    try {
      const pref = await this.read(p, async (tx) => {
        await this.reference(tx, p, r.report_id, agent);
        return this.preference(tx, p);
      });
      if (!pref.enabled) return this.view('DISABLED', r.report_id);
      const prepared = await this.prepared(p, r.report_id, agent);

      return await this.command(p, async (tx, scope) => {
        await this.reference(tx, p, r.report_id, agent);

        const consent = await this.preference(tx, p);
        if (!consent.enabled) return this.view('DISABLED', r.report_id);
        const row = (
          await tx.query<ExecutionRow>(
            'SELECT * FROM app.ai_executions WHERE user_id=$1 AND id=$2',
            [p.userId, target],
          )
        ).rows[0];
        if (!row) return this.view('EXPIRED', r.report_id);
        const m = await this.expire(
          tx,
          scope,
          await this.load(tx, p, row),
          await this.now(tx),
        );
        if (
          prepared.stale ||
          (agent === 'ESTRATEGISTA' &&
            (await this.strategies.prepared(p, r.report_id, tx)).stale)
        )
          return this.view('STALE', r.report_id, m, true);
        if (row.consent_revision !== consent.revision)
          return this.view('CANCELLED', r.report_id, m);
        if (
          m.data.inputFingerprint !== prepared.inputFingerprint ||
          m.data.sourceFingerprint !== prepared.sourceFingerprint
        )
          throw new PlatformFailure('integrity');
        return this.view(m.row.state, r.report_id, m, true, prepared.context);
      });
    } catch (e) {
      if (e instanceof PlatformFailure && e.code === 'not_found')
        return this.view('EXPIRED', r.report_id);
      throw e;
    }
  }
  // Read only authenticated proposal routing; final adoption must still call adoptable under Game's guard.
  async strategyCommand(p: SessionPrincipal, target: string) {
    return this.read(p, async (tx) => {
      const row = (
        await tx.query<ExecutionRow>(
          'SELECT * FROM app.ai_executions WHERE user_id=$1 AND id=$2',
          [p.userId, id(target)],
        )
      ).rows[0];
      if (!row || row.config_version !== STRATEGY_CONFIG)
        throw new PlatformFailure('not_found');
      const m = await this.load(tx, p, row),
        consent = await this.preference(tx, p);
      if (
        row.state !== 'SUCCEEDED' ||
        row.expires_at <= (await this.now(tx)) ||
        !consent.enabled ||
        consent.revision !== row.consent_revision
      )
        throw new PlatformFailure('conflict');
      const result = strategyOutput(m.data.result, null),
        subject = await this.strategies.load(tx, p, row.report_id);
      return {
        proposal: result.proposal,
        intent: subject.data.intent,
        goalRevision: subject.data.references.goalRevision,
      };
    });
  }
  async adoptable(
    tx: Transaction,
    p: SessionPrincipal,
    target: string,
    requireProposal = true,
  ) {
    const consent = await this.preference(tx, p);
    if (!consent.enabled) throw new PlatformFailure('conflict');
    const row = (
      await tx.query<ExecutionRow>(
        'SELECT * FROM app.ai_executions WHERE user_id=$1 AND id=$2',
        [p.userId, id(target)],
      )
    ).rows[0];
    if (!row || row.config_version !== STRATEGY_CONFIG)
      throw new PlatformFailure('not_found');
    const m = await this.load(tx, p, row);
    if (
      row.state !== 'SUCCEEDED' ||
      row.consent_revision !== consent.revision ||
      row.expires_at <= (await this.now(tx))
    )
      throw new PlatformFailure('conflict');
    const fresh = await this.strategies.prepared(p, row.report_id, tx);
    if (
      fresh.stale ||
      fresh.sourceFingerprint !== m.data.sourceFingerprint ||
      fresh.inputFingerprint !== m.data.inputFingerprint ||
      !fresh.context
    )
      throw new PlatformFailure('conflict');
    const result = strategyOutput(m.data.result, fresh.context);
    if (requireProposal && !result.proposal)
      throw new PlatformFailure('conflict');
    const subject = await this.strategies.load(tx, p, row.report_id);
    return { proposal: result.proposal, intent: subject.data.intent };
  }
  async remove(p: SessionPrincipal, target: string) {
    id(target);
    await this.read(p, async (tx) => {
      const r = (
        await tx.query<ExecutionRow>(
          'SELECT * FROM app.ai_executions WHERE user_id=$1 AND id=$2',
          [p.userId, target],
        )
      ).rows[0];
      if (!r) throw new PlatformFailure('not_found');
      await this.load(tx, p, r);
      await tx.query("SELECT set_config('forja.delete_ai',$1,true)", [target]);
      await tx.query(
        'DELETE FROM app.ai_executions WHERE user_id=$1 AND id=$2',
        [p.userId, target],
      );
    });
    this.active.get(target)?.controller.abort();
  }
  async request(
    p: SessionPrincipal,
    reportId: string,
    key: string,
    retryOf: string | null,
    agent: Agent = 'ALQUIMISTA',
  ): Promise<AiView> {
    id(reportId);
    idempotency(key);
    if (retryOf !== null) id(retryOf);
    const fp = hash([
      agent === 'ESTRATEGISTA' ? 'estrategista-intent' : 'alquimista-intent',
      1,
      reportId,
      retryOf,
    ]);
    const pref = await this.read(p, async (tx) => {
      await this.reference(tx, p, reportId, agent);
      return this.preference(tx, p);
    });
    if (!pref.enabled) return this.view('DISABLED', reportId);
    const prepared = await this.prepared(p, reportId, agent);
    if (prepared.stale) return this.view('STALE', reportId);
    const admission = await this.command(
      p,
      async (tx, scope): Promise<{ view: AiView; run: Loaded | null }> => {
        const source = await this.reference(tx, p, reportId, agent),
          consent = await this.preference(tx, p),
          at = await this.now(tx);
        if (!consent.enabled)
          return { view: this.view('DISABLED', reportId), run: null };
        const priorId = await this.receipt(tx, p, key, fp);
        if (priorId) {
          const r = (
            await tx.query<ExecutionRow>(
              'SELECT * FROM app.ai_executions WHERE user_id=$1 AND id=$2',
              [p.userId, priorId],
            )
          ).rows[0];
          if (!r) return { view: this.view('EXPIRED', reportId), run: null };
          const m = await this.expire(tx, scope, await this.load(tx, p, r), at);
          if (r.consent_revision !== consent.revision)
            return { view: this.view('CANCELLED', reportId, m), run: null };
          return {
            view: this.view(m.row.state, reportId, m, true, prepared.context),
            run: null,
          };
        }
        const row = (
          await tx.query<ExecutionRow>(
            'SELECT * FROM app.ai_executions WHERE user_id=$1 AND report_id=$2 AND consent_revision=$3 AND prompt_version=$4 AND config_version=$5 ORDER BY attempt DESC LIMIT 1',
            [
              p.userId,
              reportId,
              consent.revision,
              PROMPT_VERSION,
              agent === 'ESTRATEGISTA' ? STRATEGY_CONFIG : CONFIG_VERSION,
            ],
          )
        ).rows[0];
        const existing = row
          ? await this.expire(tx, scope, await this.load(tx, p, row), at)
          : null;
        if (
          existing &&
          (existing.data.inputFingerprint !== prepared.inputFingerprint ||
            existing.data.sourceFingerprint !== prepared.sourceFingerprint)
        )
          throw new PlatformFailure('integrity');
        if (
          existing &&
          (retryOf === null ||
            existing.row.state === 'SUCCEEDED' ||
            existing.row.state === 'RUNNING')
        ) {
          await this.saveReceipt(
            tx,
            scope,
            key,
            existing.row.id,
            fp,
            at,
            false,
          );
          return {
            view: this.view(
              existing.row.state,
              reportId,
              existing,
              true,
              prepared.context,
            ),
            run: null,
          };
        }
        if (
          retryOf !== null &&
          (!existing ||
            existing.row.id !== retryOf ||
            existing.row.state !== 'FAILED')
        )
          throw new PlatformFailure('conflict');
        if (!prepared.context)
          return {
            view: this.view('INSUFFICIENT_CONTEXT', reportId),
            run: null,
          };
        if (!this.provider.available())
          return { view: this.view('UNAVAILABLE', reportId), run: null };
        const quota = (
          await tx.query<{ n: number; last: string | null }>(
            'SELECT count(*)::int AS n,max(dispatched_at) AS last FROM app.ai_request_receipts WHERE user_id=$1 AND dispatched_at>=$2',
            [p.userId, new Date(Date.parse(at) - 86400000).toISOString()],
          )
        ).rows[0]!;
        const running = await tx.query(
          "SELECT id FROM app.ai_executions WHERE user_id=$1 AND state='RUNNING' AND deadline>$2 LIMIT 1",
          [p.userId, at],
        );
        if (
          quota.n >= 10 ||
          (quota.last && Date.parse(at) - Date.parse(quota.last) < 60000) ||
          running.rowCount
        )
          return { view: this.view('THROTTLED', reportId), run: null };
        const r: ExecutionRow = {
          user_id: p.userId,
          id: randomUUID(),
          report_id: reportId,
          report_generation: source.generation,
          consent_revision: consent.revision,
          prompt_version: PROMPT_VERSION,
          config_version:
            agent === 'ESTRATEGISTA' ? STRATEGY_CONFIG : CONFIG_VERSION,
          attempt: (existing?.row.attempt ?? 0) + 1,
          state: 'RUNNING',
          revision: 1,
          started_at: at,
          updated_at: at,
          deadline: new Date(Date.parse(at) + 30000).toISOString(),
          expires_at: source.expiresAt,
          dek_id: scope.identity.dekId,
          dek_version: scope.identity.version,
          payload: '',
        };
        const data: Data = {
            intentFingerprint: fp,
            inputFingerprint: prepared.inputFingerprint,
            sourceFingerprint: prepared.sourceFingerprint,
            result: null,
            failure: null,
            usage: null,
          },
          payload = await this.records.seal(
            scope,
            'ai.execution',
            r.id,
            1,
            this.meta(r),
            data,
          );
        await tx.query(
          'INSERT INTO app.ai_executions VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$10,$11,$12,$13,$14,$15)',
          [
            p.userId,
            r.id,
            reportId,
            source.generation,
            consent.revision,
            PROMPT_VERSION,
            agent === 'ESTRATEGISTA' ? STRATEGY_CONFIG : CONFIG_VERSION,
            r.attempt,
            r.state,
            at,
            r.deadline,
            r.expires_at,
            scope.identity.dekId,
            scope.identity.version,
            payload,
          ],
        );
        await this.saveReceipt(tx, scope, key, r.id, fp, at, true);
        return {
          view: this.view('RUNNING', reportId, { row: r, data }),
          run: { row: r, data },
        };
      },
    );
    if (!admission.run) return admission.view;
    const m = admission.run,
      controller = new AbortController();
    this.active.set(m.row.id, { owner: p.userId, controller });
    let result: AiOutput | null = null,
      failure: Failure | null = null,
      usage: Data['usage'] = null;
    try {
      const allowed = await this.read(p, async (tx) => {
        await this.reference(tx, p, reportId, agent);
        if (
          agent === 'ESTRATEGISTA' &&
          (await this.strategies.prepared(p, reportId, tx)).stale
        )
          throw new AiFailure('SOURCE_EXPIRED');
        const c = await this.preference(tx, p),
          r = (
            await tx.query<ExecutionRow>(
              'SELECT * FROM app.ai_executions WHERE user_id=$1 AND id=$2',
              [p.userId, m.row.id],
            )
          ).rows[0];
        if (r?.state === 'RUNNING' && r.deadline <= (await this.now(tx)))
          throw new AiFailure('OUTCOME_UNKNOWN');
        return (
          c.enabled &&
          c.revision === m.row.consent_revision &&
          r?.state === 'RUNNING'
        );
      });
      if (!allowed) throw new AiFailure('CONSENT_REVOKED');
      // No transaction, key admission or raw report reference crosses this network await.
      const response: ProviderResult = await this.provider.run(
        prepared.context!,
        controller.signal,
      );
      result = this.parseOutput(response.value, prepared.context!, agent);
      usage = {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        durationMs: response.durationMs,
        requestId: response.requestId,
      };
    } catch (e) {
      failure =
        e instanceof AiFailure
          ? e.kind
          : e instanceof PlatformFailure && e.code === 'not_found'
            ? 'SOURCE_EXPIRED'
            : 'UNAVAILABLE';
    } finally {
      this.active.delete(m.row.id);
    }
    const view = await this.command(p, async (tx, scope) => {
      const r = (
        await tx.query<ExecutionRow>(
          'SELECT * FROM app.ai_executions WHERE user_id=$1 AND id=$2',
          [p.userId, m.row.id],
        )
      ).rows[0];
      if (!r) return this.view('EXPIRED', reportId);
      let current = await this.load(tx, p, r);
      const at = await this.now(tx),
        consent = await this.preference(tx, p);
      if (!consent.enabled || consent.revision !== r.consent_revision) {
        current = await this.terminal(
          tx,
          scope,
          current,
          'CANCELLED',
          null,
          'CONSENT_REVOKED',
          null,
          at,
        );
        return this.view('CANCELLED', reportId, current);
      }
      try {
        await this.reference(tx, p, reportId, agent);
      } catch (e) {
        if (e instanceof PlatformFailure && e.code === 'not_found') {
          current = await this.terminal(
            tx,
            scope,
            current,
            'FAILED',
            null,
            'SOURCE_EXPIRED',
            null,
            at,
          );
          return this.view('FAILED', reportId, current);
        }
        throw e;
      }
      if (
        agent === 'ESTRATEGISTA' &&
        (await this.strategies.prepared(p, reportId, tx)).stale
      ) {
        await this.terminal(
          tx,
          scope,
          current,
          'CANCELLED',
          null,
          'SOURCE_EXPIRED',
          null,
          at,
        );
        return this.view('STALE', reportId);
      }
      if (current.row.deadline <= at) {
        failure = 'OUTCOME_UNKNOWN';
        result = null;
      }
      if (!this.provider.available()) {
        failure = 'CONFIGURATION';
        result = null;
      }
      if (current.row.state === 'RUNNING')
        current = await this.terminal(
          tx,
          scope,
          current,
          result && failure === null ? 'SUCCEEDED' : 'FAILED',
          failure === null ? result : null,
          failure,
          usage,
          at,
        );
      return this.view(
        current.row.state,
        reportId,
        current,
        false,
        prepared.context,
      );
    });
    this.logger.event(
      'ai.execution',
      view.state === 'SUCCEEDED' ? 'success' : 'unavailable',
    );
    return view;
  }
}
