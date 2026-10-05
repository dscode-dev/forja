import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IdentityService } from '../identity/identity.service';
import { SessionPrincipal } from '../platform/auth-control';
import { Database, Transaction } from '../platform/database';
import { CryptoPlatform } from '../platform/crypto/crypto-platform';
import { KeyScope } from '../platform/crypto/key-service';
import { PrivacyErasure } from '../platform/privacy-erasure';
import { SafeLogger } from '../platform/safe-logger';
import { PlatformFailure } from '../platform/failure';
import {
  EncryptedRecord,
  EncryptedRow,
  hash,
  envelopeHash,
} from '../platform/encrypted-record';
import { Currency, currency, currencyDigits, minor, add } from './money';
import {
  Account,
  FinancialEvent,
  CommandResult,
  account,
  event,
  checkpoint,
  bucket,
  receipt,
  stream,
} from './model';
import { id, idempotency, note, instant, page, cursor } from './validation';
interface AccountRow extends EncryptedRow {
  id: string;
  currency: Currency;
  state: 'active' | 'closed';
  last_seq: string;
}
interface EventRow extends EncryptedRow {
  id: string;
  seq: string;
  account_id: string;
  currency: Currency;
  effective_at: string;
  recorded_at: string;
  reversal_of: string | null;
  replacement_of: string | null;
  expected_id: string | null;
}
interface StreamRow extends EncryptedRow {
  seq: string;
}
interface BucketRow extends EncryptedRow {
  account_id: string;
  currency: Currency;
  day: string;
  month: string;
  last_seq: string;
}
export type FinanceReadUnitOfWork = Pick<
  FinanceUnitOfWork,
  'tx' | 'principal' | 'seq' | 'chain'
>;
export interface FinanceUnitOfWork {
  readonly tx: Transaction;
  readonly scope: KeyScope;
  readonly principal: SessionPrincipal;
  readonly kind: string;
  readonly key: string;
  seq: number;
  chain: string;
}
const emptyChain = '0'.repeat(64);
@Injectable()
export class FinanceService {
  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoPlatform,
    private readonly identity: IdentityService,
    private readonly records: EncryptedRecord,
    private readonly logger: SafeLogger,
    erasure: PrivacyErasure,
  ) {
    erasure.register('finance', async (tx, owner) => {
      for (const table of [
        'finance_anchor_outbox',
        'finance_receipts',
        'finance_buckets',
        'finance_checkpoints',
        'finance_events',
        'finance_accounts',
        'finance_streams',
      ])
        await tx.query(`DELETE FROM app.${table} WHERE user_id=$1`, [owner]);
    });
  }
  async ready(): Promise<boolean> {
    try {
      await this.db.query(
        'SELECT s.seq,a.id,e.id,r.id,b.day,c.seq,o.seq FROM app.finance_streams s CROSS JOIN app.finance_accounts a CROSS JOIN app.finance_events e CROSS JOIN app.finance_receipts r CROSS JOIN app.finance_buckets b CROSS JOIN app.finance_checkpoints c CROSS JOIN app.finance_anchor_outbox o LIMIT 0',
      );
      return true;
    } catch {
      return false;
    }
  }
  private async owner(tx: Transaction, p: SessionPrincipal) {
    await tx.query("SELECT set_config('forja.user_id',$1,true)", [p.userId]);
    tx.beforeCommit(() => this.identity.assertOwner(p, p.userId));
  }
  private aMeta(r: AccountRow) {
    return [r.currency, r.state, Number(r.last_seq)];
  }
  private eMeta(r: EventRow) {
    return [
      Number(r.seq),
      r.account_id,
      r.currency,
      r.effective_at,
      r.recorded_at,
      r.reversal_of,
      r.replacement_of,
      r.expected_id,
    ];
  }
  private bMeta(r: BucketRow) {
    return [r.account_id, r.currency, r.day, r.month, Number(r.last_seq)];
  }
  private async trustedHead(
    tx: Transaction,
    p: SessionPrincipal,
    seq: number,
    chain: string,
  ) {
    const head = await this.crypto.lifecycle.anchorHead(p.userId);
    if (head) {
      const row = (
        await tx.query<EncryptedRow>(
          'SELECT * FROM app.finance_checkpoints WHERE user_id=$1 AND seq=$2',
          [p.userId, head.seq],
        )
      ).rows[0];
      if (!row || head.seq > seq || envelopeHash(row.payload) !== head.digest)
        throw new PlatformFailure('integrity');
    }
    if (seq > 0) {
      const row = (
        await tx.query<EncryptedRow>(
          'SELECT * FROM app.finance_checkpoints WHERE user_id=$1 AND seq=$2',
          [p.userId, seq],
        )
      ).rows[0];
      if (!row) throw new PlatformFailure('integrity');
      const cp = await this.records.open(
        p,
        row,
        'finance.checkpoint',
        p.userId,
        [seq],
        checkpoint,
        tx,
      );
      if (cp.chain !== chain) throw new PlatformFailure('integrity');
    } else if (chain !== emptyChain) throw new PlatformFailure('integrity');
  }
  private async lockedStream(
    tx: Transaction,
    p: SessionPrincipal,
  ): Promise<{ seq: number; chain: string } | undefined> {
    const row = (
      await tx.query<StreamRow>(
        'SELECT * FROM app.finance_streams WHERE user_id=$1 FOR UPDATE',
        [p.userId],
      )
    ).rows[0];
    if (!row) {
      const existing = (
        await tx.query(
          'SELECT id FROM app.finance_accounts WHERE user_id=$1 LIMIT 1',
          [p.userId],
        )
      ).rows[0];
      if (existing || (await this.crypto.lifecycle.anchorHead(p.userId)))
        throw new PlatformFailure('integrity');
      return undefined;
    }
    const value = await this.records.open(
      p,
      row,
      'finance.stream',
      p.userId,
      [Number(row.seq)],
      stream,
      tx,
    );
    await this.trustedHead(tx, p, Number(row.seq), value.chain);
    return { seq: Number(row.seq), chain: value.chain };
  }
  async command(
    p: SessionPrincipal,
    kind: string,
    key: string,
    semantics: unknown,
    operation: (u: FinanceUnitOfWork) => Promise<CommandResult>,
  ): Promise<CommandResult> {
    await this.identity.assertOwner(p, p.userId);
    idempotency(key);
    const active = await this.crypto.lifecycle.active(p.userId),
      fingerprint = hash(['forja-finance-command', 1, kind, semantics]);
    const result = await this.crypto.keys.withKey(
      active,
      p.binding,
      'encrypt',
      (scope) =>
        this.crypto.keys.transaction(scope, async (tx) => {
          await this.owner(tx, p);
          // A real owner row serializes initial stream creation and every module command across processes.
          await tx.query(
            'SELECT id FROM app.users WHERE id=$1 FOR NO KEY UPDATE',
            [p.userId],
          );
          let state = await this.lockedStream(tx, p);
          if (!state) {
            const payload = await this.records.seal(
              scope,
              'finance.stream',
              p.userId,
              1,
              [0],
              { chain: emptyChain, rule: 1 },
            );
            await tx.query(
              'INSERT INTO app.finance_streams VALUES($1,0,1,$2,$3,$4)',
              [p.userId, active.dekId, active.version, payload],
            );
            state = { seq: 0, chain: emptyChain };
          }
          const prior = (
            await tx.query<EncryptedRow>(
              'SELECT * FROM app.finance_receipts WHERE user_id=$1 AND kind=$2 AND id=$3',
              [p.userId, kind, key],
            )
          ).rows[0];
          if (prior) {
            const value = await this.records.open(
              p,
              prior,
              'finance.receipt',
              key,
              [kind],
              receipt,
              tx,
            );
            if (value.fingerprint !== fingerprint)
              throw new PlatformFailure('conflict');
            return value.result;
          }
          const u: FinanceUnitOfWork = {
            tx,
            scope,
            principal: p,
            kind,
            key,
            ...state,
          };
          const value = await operation(u);
          const payload = await this.records.seal(
            scope,
            'finance.receipt',
            key,
            1,
            [kind],
            { fingerprint, result: value },
          );
          await tx.query(
            'INSERT INTO app.finance_receipts VALUES($1,$2,$3,1,$4,$5,$6)',
            [p.userId, kind, key, active.dekId, active.version, payload],
          );
          const s = (
            await tx.query<StreamRow>(
              'SELECT * FROM app.finance_streams WHERE user_id=$1',
              [p.userId],
            )
          ).rows[0]!;
          const updated = await this.records.seal(
            scope,
            'finance.stream',
            p.userId,
            s.revision + 1,
            [u.seq],
            { chain: u.chain, rule: 1 },
          );
          await tx.query(
            'UPDATE app.finance_streams SET seq=$2,revision=revision+1,dek_id=$3,dek_version=$4,payload=$5 WHERE user_id=$1 AND revision=$6',
            [
              p.userId,
              u.seq,
              active.dekId,
              active.version,
              updated,
              s.revision,
            ],
          );
          return value;
        }),
    );
    // Postcommit journal failure is an alert, never a claim the already committed money rolled back.
    try {
      await this.anchorPending(p);
    } catch {
      this.logger.event('finance.anchor', 'unavailable');
    }
    return result;
  }
  async anchorPending(p: SessionPrincipal): Promise<void> {
    await this.identity.assertOwner(p, p.userId);
    await this.db.transaction(async (tx) => {
      await this.owner(tx, p);
      await tx.query('SELECT id FROM app.users WHERE id=$1 FOR NO KEY UPDATE', [
        p.userId,
      ]);
      const current = await this.lockedStream(tx, p);
      if (!current) return;
      const rows = (
        await tx.query<EncryptedRow & { seq: string }>(
          'SELECT c.* FROM app.finance_anchor_outbox o JOIN app.finance_checkpoints c USING(user_id,seq) WHERE o.user_id=$1 ORDER BY o.seq LIMIT 100',
          [p.userId],
        )
      ).rows;
      for (const r of rows) {
        await this.records.open(
          p,
          r,
          'finance.checkpoint',
          p.userId,
          [Number(r.seq)],
          checkpoint,
          tx,
        );
        await this.crypto.lifecycle.anchor(
          p.userId,
          Number(r.seq),
          envelopeHash(r.payload),
        );
        await tx.query(
          'DELETE FROM app.finance_anchor_outbox WHERE user_id=$1 AND seq=$2',
          [p.userId, r.seq],
        );
      }
    });
  }
  async snapshot<T>(
    p: SessionPrincipal,
    operation: (u: FinanceReadUnitOfWork) => Promise<T>,
  ): Promise<T> {
    await this.identity.assertOwner(p, p.userId);
    return this.db.transaction(async (tx) => {
      await this.owner(tx, p);
      await tx.query('SELECT id FROM app.users WHERE id=$1 FOR NO KEY UPDATE', [
        p.userId,
      ]);
      const head = await this.lockedStream(tx, p);
      if (!head) throw new PlatformFailure('not_found');
      return operation({ tx, principal: p, ...head });
    });
  }
  async assertUnsettled(
    u: FinanceReadUnitOfWork,
    expectedId: string,
  ): Promise<void> {
    const result = await u.tx.query(
      'SELECT id FROM app.finance_events WHERE user_id=$1 AND expected_id=$2',
      [u.principal.userId, expectedId],
    );
    if (result.rowCount) throw new PlatformFailure('integrity');
  }
  async requireAccount(
    u: FinanceReadUnitOfWork,
    accountId: string,
  ): Promise<{ row: AccountRow; value: Account }> {
    const row = (
      await u.tx.query<AccountRow>(
        'SELECT * FROM app.finance_accounts WHERE user_id=$1 AND id=$2 FOR UPDATE',
        [u.principal.userId, id(accountId)],
      )
    ).rows[0];
    if (!row) throw new PlatformFailure('not_found');
    currency(row.currency);
    const value = await this.records.open(
      u.principal,
      row,
      'finance.account',
      row.id,
      this.aMeta(row),
      account,
      u.tx,
    );
    const cpRow = (
      await u.tx.query<EncryptedRow>(
        'SELECT * FROM app.finance_checkpoints WHERE user_id=$1 AND seq=$2',
        [u.principal.userId, row.last_seq],
      )
    ).rows[0];
    const latest = (
      await u.tx.query<{ id: string; seq: string }>(
        'SELECT id,seq FROM app.finance_events WHERE user_id=$1 AND account_id=$2 ORDER BY seq DESC LIMIT 1',
        [u.principal.userId, row.id],
      )
    ).rows[0];
    if (
      !latest ||
      latest.seq !== row.last_seq ||
      latest.id !== value.lastEvent ||
      !cpRow
    )
      throw new PlatformFailure('integrity');
    const cp = await this.records.open(
      u.principal,
      cpRow,
      'finance.checkpoint',
      u.principal.userId,
      [Number(row.last_seq)],
      checkpoint,
      u.tx,
    );
    if (
      cp.accountHash !==
      hash([
        row.id,
        row.currency,
        row.state,
        row.revision,
        Number(row.last_seq),
        value,
      ])
    )
      throw new PlatformFailure('integrity');
    return { row, value };
  }
  async post(
    u: FinanceUnitOfWork,
    accountId: string,
    kind: 'income' | 'expense',
    amount: string,
    effectiveAt: string,
    description: string,
    expectedId: string | null = null,
  ): Promise<CommandResult> {
    const { row, value } = await this.requireAccount(u, accountId);
    if (row.state !== 'active') throw new PlatformFailure('conflict');
    const magnitude = minor(amount, true);
    const at = instant(effectiveAt, true);
    if (at < value.openedAt) throw new PlatformFailure('conflict');
    const eventId = await this.append(
      u,
      row,
      value,
      kind,
      (kind === 'income' ? magnitude : -magnitude).toString(),
      at,
      note(description),
      null,
      null,
      expectedId,
    );
    return {
      accountId: row.id,
      eventIds: [eventId],
      expectedId,
      state: expectedId ? 'settled' : 'posted',
      seq: u.seq,
    };
  }
  private async append(
    u: FinanceUnitOfWork,
    row: AccountRow,
    value: Account,
    kind: FinancialEvent['kind'],
    delta: string,
    at: string,
    description: string,
    reversalOf: string | null = null,
    replacementOf: string | null = null,
    expectedId: string | null = null,
    classification: FinancialEvent['classification'] = kind === 'income'
      ? 'income'
      : kind === 'expense'
        ? 'expense'
        : 'baseline',
  ): Promise<string> {
    const eventId = randomUUID(),
      seq = ++u.seq,
      recorded = new Date().toISOString();
    if (!Number.isSafeInteger(seq) || seq >= 9007199254740990)
      throw new PlatformFailure('exhausted');
    const ev: FinancialEvent = {
      state: 'posted',
      previousState: kind === 'opening' ? null : 'active',
      nextState: row.state,
      kind,
      classification,
      deltaMinor: minor(delta).toString(),
      note: description,
      source: 'user-confirmed',
      previousHash: u.chain,
      commandKind: u.kind,
      commandKey: u.key,
      actor: u.principal.userId,
      expectedId,
    };
    const newValue: Account = {
      ...value,
      balanceMinor: kind === 'opening' ? delta : add(value.balanceMinor, delta),
      lastEvent: eventId,
    };
    const updated: AccountRow = {
      ...row,
      revision: row.revision + 1,
      last_seq: String(seq),
      dek_id: u.scope.identity.dekId,
      dek_version: u.scope.identity.version,
    };
    const aPayload = await this.records.seal(
      u.scope,
      'finance.account',
      row.id,
      updated.revision,
      this.aMeta(updated),
      newValue,
    );
    const result = await u.tx.query(
      'UPDATE app.finance_accounts SET revision=$3,last_seq=$4,dek_id=$5,dek_version=$6,payload=$7,state=$8 WHERE user_id=$1 AND id=$2 AND revision=$9',
      [
        row.user_id,
        row.id,
        updated.revision,
        seq,
        updated.dek_id,
        updated.dek_version,
        aPayload,
        updated.state,
        row.revision,
      ],
    );
    if (result.rowCount !== 1) throw new PlatformFailure('conflict');
    const eRow: EventRow = {
      ...updated,
      id: eventId,
      seq: String(seq),
      account_id: row.id,
      effective_at: at,
      recorded_at: recorded,
      reversal_of: reversalOf,
      replacement_of: replacementOf,
      expected_id: expectedId,
      revision: 1,
      payload: '',
    };
    const ePayload = await this.records.seal(
      u.scope,
      'finance.event',
      eventId,
      1,
      this.eMeta(eRow),
      ev,
    );
    await u.tx.query(
      'INSERT INTO app.finance_events VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13)',
      [
        row.user_id,
        eventId,
        seq,
        row.id,
        row.currency,
        at,
        recorded,
        reversalOf,
        replacementOf,
        expectedId,
        updated.dek_id,
        updated.dek_version,
        ePayload,
      ],
    );
    const bHash = await this.updateBucket(
      u,
      row,
      kind,
      delta,
      at,
      seq,
      classification,
    );
    u.chain = hash([
      'forja-event',
      1,
      row.user_id,
      eventId,
      seq,
      row.id,
      row.currency,
      at,
      recorded,
      reversalOf,
      replacementOf,
      ev,
    ]);
    const cp = {
      chain: u.chain,
      eventId,
      accountHash: hash([
        row.id,
        row.currency,
        updated.state,
        updated.revision,
        seq,
        newValue,
      ]),
      bucketHash: bHash,
      rule: 1,
    };
    const cPayload = await this.records.seal(
      u.scope,
      'finance.checkpoint',
      row.user_id,
      1,
      [seq],
      cp,
    );
    await u.tx.query(
      'INSERT INTO app.finance_checkpoints VALUES($1,$2,1,$3,$4,$5)',
      [row.user_id, seq, updated.dek_id, updated.dek_version, cPayload],
    );
    await u.tx.query('INSERT INTO app.finance_anchor_outbox VALUES($1,$2)', [
      row.user_id,
      seq,
    ]);
    return eventId;
  }
  private async updateBucket(
    u: FinanceUnitOfWork,
    row: AccountRow,
    kind: FinancialEvent['kind'],
    delta: string,
    at: string,
    seq: number,
    classification: FinancialEvent['classification'],
  ) {
    const day = at.slice(0, 10),
      month = day.slice(0, 7),
      entity = row.id;
    const prior = (
      await u.tx.query<BucketRow>(
        'SELECT * FROM app.finance_buckets WHERE user_id=$1 AND account_id=$2 AND day=$3 FOR UPDATE',
        [row.user_id, row.id, day],
      )
    ).rows[0];
    const previousEvent = (
      await u.tx.query<{ seq: string }>(
        'SELECT seq FROM app.finance_events WHERE user_id=$1 AND account_id=$2 AND left(effective_at,10)=$3 AND seq<$4 ORDER BY seq DESC LIMIT 1',
        [row.user_id, row.id, day, seq],
      )
    ).rows[0];
    if (
      (prior && prior.last_seq !== previousEvent?.seq) ||
      (!prior && previousEvent)
    )
      throw new PlatformFailure('integrity');
    const old = prior
      ? await this.records.open(
          u.principal,
          prior,
          'finance.bucket',
          entity,
          this.bMeta(prior),
          bucket,
          u.tx,
        )
      : {
          contributionMinor: '0',
          incomeMinor: '0',
          expenseMinor: '0',
          rule: 1 as const,
        };
    if (prior) {
      const cpRow = (
        await u.tx.query<EncryptedRow>(
          'SELECT * FROM app.finance_checkpoints WHERE user_id=$1 AND seq=$2',
          [row.user_id, prior.last_seq],
        )
      ).rows[0];
      if (!cpRow) throw new PlatformFailure('integrity');
      const cp = await this.records.open(
        u.principal,
        cpRow,
        'finance.checkpoint',
        row.user_id,
        [Number(prior.last_seq)],
        checkpoint,
        u.tx,
      );
      if (
        cp.bucketHash !==
        hash([row.id, day, prior.revision, Number(prior.last_seq), old])
      )
        throw new PlatformFailure('integrity');
    }
    const actual = kind === 'opening' || kind === 'closed' ? '0' : delta;
    // Net contributions include adjustments; income/expense totals preserve sign on corrections.
    const next = {
      contributionMinor: add(old.contributionMinor, actual),
      incomeMinor: add(
        old.incomeMinor,
        classification === 'income' ? actual : '0',
      ),
      expenseMinor: add(
        old.expenseMinor,
        classification === 'expense' ? (-minor(actual)).toString() : '0',
      ),
      rule: 1,
    };
    const revision = (prior?.revision ?? 0) + 1,
      bRow: BucketRow = {
        ...row,
        account_id: row.id,
        day,
        month,
        last_seq: String(seq),
        revision,
        payload: '',
      };
    const payload = await this.records.seal(
      u.scope,
      'finance.bucket',
      entity,
      revision,
      this.bMeta(bRow),
      next,
    );
    await u.tx.query(
      'INSERT INTO app.finance_buckets VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,account_id,day) DO UPDATE SET last_seq=EXCLUDED.last_seq,revision=EXCLUDED.revision,dek_id=EXCLUDED.dek_id,dek_version=EXCLUDED.dek_version,payload=EXCLUDED.payload',
      [
        row.user_id,
        row.id,
        row.currency,
        day,
        month,
        seq,
        revision,
        u.scope.identity.dekId,
        u.scope.identity.version,
        payload,
      ],
    );
    return hash([row.id, day, revision, seq, next]);
  }
  async createAccount(
    p: SessionPrincipal,
    key: string,
    input: {
      name: string;
      type: 'cash' | 'savings';
      currency: Currency;
      openingMinor: string;
      openedAt: string;
      source: 'user-confirmed';
    },
  ) {
    const canonical = {
      name: note(input.name),
      type: input.type,
      currency: currency(input.currency),
      openingMinor: minor(input.openingMinor).toString(),
      openedAt: instant(input.openedAt, true),
      source: input.source,
    };
    if (
      !['cash', 'savings'].includes(canonical.type) ||
      canonical.source !== 'user-confirmed'
    )
      throw new PlatformFailure('conflict');
    return this.command(p, 'account.create', key, canonical, async (u) => {
      const accountId = randomUUID(),
        row: AccountRow = {
          user_id: p.userId,
          id: accountId,
          currency: canonical.currency,
          state: 'active',
          last_seq: String(u.seq + 1),
          revision: 1,
          dek_id: u.scope.identity.dekId,
          dek_version: u.scope.identity.version,
          payload: '',
        };
      const value: Account = {
        name: canonical.name,
        type: canonical.type,
        balanceMinor: canonical.openingMinor,
        openedAt: canonical.openedAt,
        lastEvent: randomUUID(),
        rule: 1,
      };
      const payload = await this.records.seal(
        u.scope,
        'finance.account',
        accountId,
        1,
        this.aMeta(row),
        value,
      );
      await u.tx.query(
        'INSERT INTO app.finance_accounts VALUES($1,$2,$3,$4,$5,1,$6,$7,$8)',
        [
          p.userId,
          accountId,
          row.currency,
          row.state,
          row.last_seq,
          row.dek_id,
          row.dek_version,
          payload,
        ],
      );
      const opening = await this.append(
        u,
        row,
        value,
        'opening',
        canonical.openingMinor,
        canonical.openedAt,
        'Opening baseline confirmed by user',
      );
      return {
        accountId,
        eventIds: [opening],
        expectedId: null,
        state: 'active',
        seq: u.seq,
      };
    });
  }
  async posting(
    p: SessionPrincipal,
    key: string,
    kind: 'income' | 'expense',
    input: {
      accountId: string;
      amountMinor: string;
      effectiveAt: string;
      note: string;
    },
  ) {
    const semantic = {
      accountId: id(input.accountId),
      amountMinor: minor(input.amountMinor, true).toString(),
      effectiveAt: instant(input.effectiveAt, true),
      note: note(input.note),
    };
    return this.command(p, `posting.${kind}`, key, semantic, (u) =>
      this.post(
        u,
        semantic.accountId,
        kind,
        semantic.amountMinor,
        semantic.effectiveAt,
        semantic.note,
      ),
    );
  }
  async adjust(
    p: SessionPrincipal,
    key: string,
    eventId: string,
    correction?: {
      kind: 'income' | 'expense';
      amountMinor: string;
      effectiveAt: string;
      note: string;
    },
  ) {
    const target = id(eventId),
      fixed = correction
        ? {
            kind: correction.kind,
            amountMinor: minor(correction.amountMinor, true).toString(),
            effectiveAt: instant(correction.effectiveAt, true),
            note: note(correction.note),
          }
        : null;
    return this.command(
      p,
      fixed ? 'posting.correct' : 'posting.reverse',
      key,
      { target, fixed },
      async (u) => {
        const original = (
          await u.tx.query<EventRow>(
            'SELECT * FROM app.finance_events WHERE user_id=$1 AND id=$2',
            [p.userId, target],
          )
        ).rows[0];
        if (!original) throw new PlatformFailure('not_found');
        const old = await this.records.open(
          p,
          original,
          'finance.event',
          target,
          this.eMeta(original),
          event,
          u.tx,
        );
        if (!['income', 'expense', 'replacement'].includes(old.kind))
          throw new PlatformFailure('conflict');
        const reversed = await u.tx.query(
          'SELECT id FROM app.finance_events WHERE user_id=$1 AND reversal_of=$2',
          [p.userId, target],
        );
        if (reversed.rowCount) throw new PlatformFailure('conflict');
        let { row, value } = await this.requireAccount(u, original.account_id);
        if (row.state !== 'active') throw new PlatformFailure('conflict');
        const reverse = await this.append(
          u,
          row,
          value,
          'reversal',
          (-minor(old.deltaMinor)).toString(),
          original.effective_at,
          'User-confirmed reversal',
          target,
          null,
          null,
          old.classification,
        );
        const events = [reverse];
        if (fixed) {
          ({ row, value } = await this.requireAccount(u, original.account_id));
          if (fixed.effectiveAt < value.openedAt)
            throw new PlatformFailure('conflict');
          events.push(
            await this.append(
              u,
              row,
              value,
              'replacement',
              (fixed.kind === 'income'
                ? minor(fixed.amountMinor)
                : -minor(fixed.amountMinor)
              ).toString(),
              fixed.effectiveAt,
              fixed.note,
              null,
              target,
              null,
              fixed.kind,
            ),
          );
        }
        return {
          accountId: row.id,
          eventIds: events,
          expectedId: null,
          state: 'posted',
          seq: u.seq,
        };
      },
    );
  }
  async closeAccount(p: SessionPrincipal, key: string, accountId: string) {
    const target = id(accountId);
    return this.command(p, 'account.close', key, { target }, async (u) => {
      const { row, value } = await this.requireAccount(u, target);
      if (row.state !== 'active' || minor(value.balanceMinor) !== 0n)
        throw new PlatformFailure('conflict');
      const ev = await this.append(
        u,
        { ...row, state: 'closed' },
        value,
        'closed',
        '0',
        new Date().toISOString(),
        'Account closed',
      );
      return {
        accountId: target,
        eventIds: [ev],
        expectedId: null,
        state: 'closed',
        seq: u.seq,
      };
    });
  }
  async accounts(
    p: SessionPrincipal,
    after: string | undefined,
    limit: number,
  ) {
    limit = page(limit);
    await this.identity.assertOwner(p, p.userId);
    return this.db.transaction(async (tx) => {
      await this.owner(tx, p);
      const head = await this.lockedStream(tx, p);
      if (!head) return { accounts: [], cursor: 0, next: null, rule: 1 };
      const rows = (
        await tx.query<AccountRow>(
          'SELECT * FROM app.finance_accounts WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3',
          [p.userId, after ? id(after) : null, limit + 1],
        )
      ).rows;
      const values = [];
      for (const row of rows.slice(0, limit)) {
        const result = await this.requireAccount(
          {
            tx,
            principal: p,
            seq: head.seq,
            chain: head.chain,
          } as FinanceUnitOfWork,
          row.id,
        );
        values.push({
          id: row.id,
          currency: row.currency,
          minorDigits: currencyDigits[row.currency],
          state: row.state,
          revision: row.revision,
          cursor: Number(row.last_seq),
          ...result.value,
        });
      }
      return {
        accounts: values,
        cursor: head.seq,
        next: rows.length > limit ? rows[limit - 1]!.id : null,
        rule: 1,
      };
    });
  }
  async history(
    p: SessionPrincipal,
    accountId: string,
    after: number,
    limit: number,
  ) {
    limit = page(limit);
    after = cursor(after);
    await this.identity.assertOwner(p, p.userId);
    return this.db.transaction(async (tx) => {
      await this.owner(tx, p);
      const head = await this.lockedStream(tx, p);
      if (!head) throw new PlatformFailure('not_found');
      await this.requireAccount(
        { tx, principal: p, ...head } as FinanceUnitOfWork,
        id(accountId),
      );
      const rows = (
        await tx.query<EventRow>(
          'SELECT * FROM app.finance_events WHERE user_id=$1 AND account_id=$2 AND seq>$3 ORDER BY seq LIMIT $4',
          [p.userId, accountId, after, limit + 1],
        )
      ).rows;
      const values = [];
      for (const row of rows.slice(0, limit)) {
        const value = await this.records.open(
          p,
          row,
          'finance.event',
          row.id,
          this.eMeta(row),
          event,
          tx,
        );
        const cpRow = (
          await tx.query<EncryptedRow>(
            'SELECT * FROM app.finance_checkpoints WHERE user_id=$1 AND seq=$2',
            [p.userId, row.seq],
          )
        ).rows[0];
        if (!cpRow) throw new PlatformFailure('integrity');
        const cp = await this.records.open(
          p,
          cpRow,
          'finance.checkpoint',
          p.userId,
          [Number(row.seq)],
          checkpoint,
          tx,
        );
        if (
          cp.chain !==
          hash([
            'forja-event',
            1,
            p.userId,
            row.id,
            Number(row.seq),
            row.account_id,
            row.currency,
            row.effective_at,
            row.recorded_at,
            row.reversal_of,
            row.replacement_of,
            value,
          ])
        )
          throw new PlatformFailure('integrity');
        if (Number(row.seq) === 1) {
          if (value.previousHash !== emptyChain)
            throw new PlatformFailure('integrity');
        } else {
          const prior = (
            await tx.query<EncryptedRow>(
              'SELECT * FROM app.finance_checkpoints WHERE user_id=$1 AND seq=$2',
              [p.userId, Number(row.seq) - 1],
            )
          ).rows[0];
          if (!prior) throw new PlatformFailure('integrity');
          const predecessor = await this.records.open(
            p,
            prior,
            'finance.checkpoint',
            p.userId,
            [Number(row.seq) - 1],
            checkpoint,
            tx,
          );
          if (value.previousHash !== predecessor.chain)
            throw new PlatformFailure('integrity');
        }
        values.push({
          id: row.id,
          seq: Number(row.seq),
          accountId: row.account_id,
          currency: row.currency,
          effectiveAt: row.effective_at,
          recordedAt: row.recorded_at,
          reversalOf: row.reversal_of,
          replacementOf: row.replacement_of,
          ...value,
        });
      }
      return {
        events: values,
        cursor: head.seq,
        next: rows.length > limit ? Number(rows[limit - 1]!.seq) : null,
        rule: 1,
      };
    });
  }
}
