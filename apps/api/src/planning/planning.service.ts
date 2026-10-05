import { PlatformFailure } from '../platform/failure';
import { Injectable, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { FinanceService, FinanceUnitOfWork } from '../finance/finance.service';
import { EncryptedRow, EncryptedRecord } from '../platform/encrypted-record';
import { Currency, currency, minor, add } from '../finance/money';
import { id, note, instant, object, page } from '../finance/validation';
import { SessionPrincipal } from '../platform/auth-control';
import { Database, Transaction } from '../platform/database';
import { IdentityService } from '../identity/identity.service';
import { PrivacyErasure } from '../platform/privacy-erasure';
interface Expected {
  kind: 'predicted-income' | 'receivable' | 'scheduled-debit' | 'payable';
  amountMinor: string;
  note: string;
  source: 'user-confirmed';
}
interface ExpectedRow extends EncryptedRow {
  id: string;
  account_id: string;
  currency: Currency;
  due_at: string;
  state: 'pending' | 'settled' | 'cancelled';
  settlement_id: string | null;
}
function expected(value: unknown): Expected {
  const r = object(value, ['kind', 'amountMinor', 'note', 'source']);
  if (
    !['predicted-income', 'receivable', 'scheduled-debit', 'payable'].includes(
      String(r['kind']),
    ) ||
    r['source'] !== 'user-confirmed'
  )
    throw new BadRequestException();
  return {
    kind: r['kind'] as Expected['kind'],
    amountMinor: minor(r['amountMinor'], true).toString(),
    note: note(r['note']),
    source: 'user-confirmed',
  };
}
function financialStatus(
  row: ExpectedRow,
  value: Expected,
  asOf: string,
): string {
  if (row.state === 'cancelled') return 'cancelled';
  if (row.state === 'settled')
    return value.kind === 'receivable' || value.kind === 'predicted-income'
      ? 'received'
      : 'paid';
  if (value.kind === 'receivable')
    return row.due_at < asOf ? 'overdue-receivable' : 'expected-receivable';
  if (value.kind === 'payable')
    return row.due_at < asOf ? 'overdue-payable' : 'expected-payable';
  return value.kind;
}
@Injectable()
export class PlanningService {
  constructor(
    private readonly finance: FinanceService,
    private readonly db: Database,
    private readonly records: EncryptedRecord,
    private readonly identity: IdentityService,
    erasure: PrivacyErasure,
  ) {
    erasure.register('planning', async (tx, owner) => {
      await tx.query(
        'DELETE FROM app.planning_expected_events WHERE user_id=$1',
        [owner],
      );
      await tx.query('DELETE FROM app.planning_expected WHERE user_id=$1', [
        owner,
      ]);
    });
  }
  async ready(): Promise<boolean> {
    try {
      await this.db.query(
        'SELECT e.id,a.revision FROM app.planning_expected e CROSS JOIN app.planning_expected_events a LIMIT 0',
      );
      return true;
    } catch {
      return false;
    }
  }
  private meta(row: ExpectedRow) {
    return [
      row.account_id,
      row.currency,
      row.due_at,
      row.state,
      row.settlement_id,
    ];
  }
  private async authenticateAudit(
    tx: Transaction,
    p: SessionPrincipal,
    row: ExpectedRow,
    value: Expected,
  ): Promise<void> {
    const latest = (
      await tx.query<EncryptedRow>(
        'SELECT * FROM app.planning_expected_events WHERE user_id=$1 AND id=$2 ORDER BY revision DESC LIMIT 1',
        [p.userId, row.id],
      )
    ).rows[0];
    if (!latest || latest.revision !== row.revision)
      throw new PlatformFailure('integrity');
    await this.records.open(
      p,
      latest,
      'planning.expected-audit',
      row.id,
      [],
      (raw) => {
        const r = object(raw, [
          'version',
          'previous',
          'state',
          'settlementId',
          'accountId',
          'currency',
          'dueAt',
          'kind',
          'amountMinor',
          'note',
          'source',
          'actor',
          'commandKind',
          'commandKey',
          'recordedAt',
        ]);
        const snapshot = expected({
          kind: r['kind'],
          amountMinor: r['amountMinor'],
          note: r['note'],
          source: r['source'],
        });
        if (
          r['version'] !== 1 ||
          r['actor'] !== p.userId ||
          r['state'] !== row.state ||
          r['settlementId'] !== row.settlement_id ||
          r['accountId'] !== row.account_id ||
          r['currency'] !== row.currency ||
          r['dueAt'] !== row.due_at ||
          JSON.stringify(snapshot) !== JSON.stringify(value) ||
          ![null, 'pending'].includes(r['previous'] as string | null)
        )
          throw new PlatformFailure('integrity');
        id(r['commandKey']);
        instant(r['recordedAt'], true);
        return snapshot;
      },
      tx,
    );
  }
  private async audit(
    u: FinanceUnitOfWork,
    row: ExpectedRow,
    value: Expected,
    previous: string | null,
  ) {
    const payload = await this.records.seal(
      u.scope,
      'planning.expected-audit',
      row.id,
      row.revision,
      [],
      {
        version: 1,
        previous,
        state: row.state,
        settlementId: row.settlement_id,
        accountId: row.account_id,
        currency: row.currency,
        dueAt: row.due_at,
        ...value,
        actor: u.principal.userId,
        commandKind: u.kind,
        commandKey: u.key,
        recordedAt: new Date().toISOString(),
      },
    );
    await u.tx.query(
      'INSERT INTO app.planning_expected_events VALUES($1,$2,$3,$4,$5,$6)',
      [
        row.user_id,
        row.id,
        row.revision,
        u.scope.identity.dekId,
        u.scope.identity.version,
        payload,
      ],
    );
  }
  async create(
    p: SessionPrincipal,
    key: string,
    input: {
      accountId: string;
      currency: Currency;
      dueAt: string;
      kind: Expected['kind'];
      amountMinor: string;
      note: string;
      source: 'user-confirmed';
    },
  ) {
    const value = expected({
        kind: input.kind,
        amountMinor: input.amountMinor,
        note: input.note,
        source: input.source,
      }),
      accountId = id(input.accountId),
      c = currency(input.currency),
      due = instant(input.dueAt);
    return this.finance.command(
      p,
      'expected.create',
      key,
      { accountId, currency: c, dueAt: due, ...value },
      async (u) => {
        const { row: account } = await this.finance.requireAccount(
          u,
          accountId,
        );
        if (account.state !== 'active' || account.currency !== c)
          throw new PlatformFailure('conflict');
        const row: ExpectedRow = {
          user_id: p.userId,
          id: randomUUID(),
          account_id: accountId,
          currency: c,
          due_at: due,
          state: 'pending',
          settlement_id: null,
          revision: 1,
          dek_id: u.scope.identity.dekId,
          dek_version: u.scope.identity.version,
          payload: '',
        };
        const payload = await this.records.seal(
          u.scope,
          'planning.expected',
          row.id,
          1,
          this.meta(row),
          value,
        );
        await u.tx.query(
          'INSERT INTO app.planning_expected VALUES($1,$2,$3,$4,$5,$6,NULL,1,$7,$8,$9)',
          [
            p.userId,
            row.id,
            accountId,
            c,
            due,
            row.state,
            row.dek_id,
            row.dek_version,
            payload,
          ],
        );
        await this.audit(u, row, value, null);
        return {
          accountId,
          eventIds: [],
          expectedId: row.id,
          state: 'pending',
          seq: u.seq,
        };
      },
    );
  }
  async transition(
    p: SessionPrincipal,
    key: string,
    target: string,
    effectiveAt: string | null,
  ) {
    const expectedId = id(target),
      at = effectiveAt === null ? null : instant(effectiveAt, true);
    return this.finance.command(
      p,
      at ? 'expected.settle' : 'expected.cancel',
      key,
      { expectedId, effectiveAt: at },
      async (u) => {
        const row = (
          await u.tx.query<ExpectedRow>(
            'SELECT * FROM app.planning_expected WHERE user_id=$1 AND id=$2 FOR UPDATE',
            [p.userId, expectedId],
          )
        ).rows[0];
        if (!row) throw new PlatformFailure('not_found');
        const value = await this.records.open(
          p,
          row,
          'planning.expected',
          row.id,
          this.meta(row),
          expected,
          u.tx,
        );
        await this.authenticateAudit(u.tx, p, row, value);
        if (row.state !== 'pending') throw new PlatformFailure('conflict');
        await this.finance.assertUnsettled(u, expectedId);
        const posted = at
          ? await this.finance.post(
              u,
              row.account_id,
              value.kind === 'predicted-income' || value.kind === 'receivable'
                ? 'income'
                : 'expense',
              value.amountMinor,
              at,
              value.note,
              expectedId,
            )
          : null;
        const next: ExpectedRow = {
          ...row,
          state: at ? 'settled' : 'cancelled',
          settlement_id: posted?.eventIds[0] ?? null,
          revision: row.revision + 1,
        };
        const payload = await this.records.seal(
          u.scope,
          'planning.expected',
          row.id,
          next.revision,
          this.meta(next),
          value,
        );
        const changed = await u.tx.query(
          'UPDATE app.planning_expected SET state=$3,settlement_id=$4,revision=$5,dek_id=$6,dek_version=$7,payload=$8 WHERE user_id=$1 AND id=$2 AND revision=$9',
          [
            p.userId,
            row.id,
            next.state,
            next.settlement_id,
            next.revision,
            u.scope.identity.dekId,
            u.scope.identity.version,
            payload,
            row.revision,
          ],
        );
        if (changed.rowCount !== 1) throw new PlatformFailure('conflict');
        await this.audit(u, next, value, 'pending');
        return (
          posted ?? {
            accountId: row.account_id,
            eventIds: [],
            expectedId,
            state: 'cancelled',
            seq: u.seq,
          }
        );
      },
    );
  }
  async list(
    p: SessionPrincipal,
    accountId: string,
    after: string | undefined,
    limit: number,
  ) {
    limit = page(limit);
    const evaluatedAt = new Date().toISOString();
    await this.identity.assertOwner(p, p.userId);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [p.userId]);
      tx.beforeCommit(() => this.identity.assertOwner(p, p.userId));
      const rows = (
        await tx.query<ExpectedRow>(
          'SELECT * FROM app.planning_expected WHERE user_id=$1 AND account_id=$2 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT $4',
          [p.userId, id(accountId), after ? id(after) : null, limit + 1],
        )
      ).rows;
      const entries = [];
      for (const row of rows.slice(0, limit)) {
        const value = await this.records.open(
          p,
          row,
          'planning.expected',
          row.id,
          this.meta(row),
          expected,
          tx,
        );
        await this.authenticateAudit(tx, p, row, value);
        entries.push({
          id: row.id,
          accountId: row.account_id,
          currency: row.currency,
          dueAt: row.due_at,
          state: row.state,
          settlementId: row.settlement_id,
          revision: row.revision,
          ...value,
          status: financialStatus(row, value, evaluatedAt),
        });
      }
      return {
        entries,
        evaluatedAt,
        next: rows.length > limit ? rows[limit - 1]!.id : null,
      };
    });
  }
  async summary(p: SessionPrincipal, accountId: string, through: string) {
    const target = id(accountId),
      horizon = instant(through);
    return this.finance.snapshot(p, async (u) => {
      const asOf = new Date().toISOString();
      if (horizon < asOf) throw new PlatformFailure('invalid');
      const { row: account, value: current } =
        await this.finance.requireAccount(u, target);
      if (account.state !== 'active') throw new PlatformFailure('conflict');
      const rows = (
        await u.tx.query<ExpectedRow>(
          "SELECT * FROM app.planning_expected WHERE user_id=$1 AND account_id=$2 AND state='pending' AND due_at<=$3 ORDER BY due_at,id LIMIT 1001",
          [p.userId, target, horizon],
        )
      ).rows;
      if (rows.length > 1000) throw new PlatformFailure('bounded_period');
      let predictedIncomeMinor = '0',
        receivableMinor = '0',
        scheduledDebitMinor = '0',
        payableMinor = '0',
        overdueReceivableMinor = '0',
        overduePayableMinor = '0';
      const expectedInputs: { id: string; revision: number }[] = [];
      for (const row of rows) {
        const value = await this.records.open(
          p,
          row,
          'planning.expected',
          row.id,
          this.meta(row),
          expected,
          u.tx,
        );
        await this.authenticateAudit(u.tx, p, row, value);
        await this.finance.assertUnsettled(u, row.id);
        if (row.currency !== account.currency)
          throw new PlatformFailure('integrity');
        if (value.kind === 'predicted-income')
          predictedIncomeMinor = add(predictedIncomeMinor, value.amountMinor);
        if (value.kind === 'scheduled-debit')
          scheduledDebitMinor = add(scheduledDebitMinor, value.amountMinor);
        if (value.kind === 'receivable') {
          receivableMinor = add(receivableMinor, value.amountMinor);
          if (row.due_at < asOf)
            overdueReceivableMinor = add(
              overdueReceivableMinor,
              value.amountMinor,
            );
        }
        if (value.kind === 'payable') {
          payableMinor = add(payableMinor, value.amountMinor);
          if (row.due_at < asOf)
            overduePayableMinor = add(overduePayableMinor, value.amountMinor);
        }
        expectedInputs.push({ id: row.id, revision: row.revision });
      }
      const expectedIncomingMinor = add(predictedIncomeMinor, receivableMinor),
        expectedOutgoingMinor = add(scheduledDebitMinor, payableMinor);
      const projectedBalanceMinor = add(
        current.balanceMinor,
        add(expectedIncomingMinor, (-minor(expectedOutgoingMinor)).toString()),
      );
      return {
        accountId: target,
        currency: account.currency,
        settledBalanceMinor: current.balanceMinor,
        projectedBalanceMinor,
        expectedIncomingMinor,
        expectedOutgoingMinor,
        predictedIncomeMinor,
        receivableMinor,
        scheduledDebitMinor,
        payableMinor,
        overdueReceivableMinor,
        overduePayableMinor,
        asOf,
        through: horizon,
        financialCursor: u.seq,
        accountCursor: Number(account.last_seq),
        accountRevision: account.revision,
        expectedInputs,
        rule: 1,
        assumptions:
          'all-pending-through-horizon-full-amount-overdue-included-no-fx-no-probability',
      };
    });
  }
}
