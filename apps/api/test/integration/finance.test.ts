import {
  EncryptedRecord,
  EncryptedRow,
} from '../../src/platform/encrypted-record';
import { bucket } from '../../src/finance/model';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { loadConfig } from '../../src/config/config';
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { harness } from '../fixtures/identity-harness';
import { FinanceService } from '../../src/finance/finance.service';
import { CommandResult } from '../../src/finance/model';
import { Transaction } from '../../src/platform/database';
import { PlatformFailure } from '../../src/platform/failure';
const openingAt = '2026-01-01T00:00:00.000Z',
  actualAt = '2026-01-02T10:00:00.000Z';
async function json<T>(r: Response, status = 200): Promise<T> {
  assert.equal(r.status, status);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  return (await r.json()) as T;
}
test('actual money, expectations, exactly-once settlement, corrections and owner isolation on real PostgreSQL', async () => {
  const h = await harness();
  try {
    const a = await h.login('finance-a'),
      b = await h.login('finance-b');
    const call = (path: string, body: unknown) =>
      h.request(path, 'POST', body, a.accessToken);
    const input = {
      idempotencyKey: randomUUID(),
      name: 'S3_ACCOUNT_CANARY_04',
      type: 'cash',
      currency: 'BRL',
      openingMinor: '100000',
      openedAt: openingAt,
      source: 'user-confirmed',
    };
    const opened = await json<CommandResult>(
        await call('finance/accounts', input),
      ),
      accountId = opened.accountId!;
    assert.deepEqual(await json(await call('finance/accounts', input)), opened);
    async function balance() {
      const value = await json<{ accounts: { balanceMinor: string }[] }>(
        await h.request('finance/accounts', 'GET', undefined, a.accessToken),
      );
      return value.accounts[0]!.balanceMinor;
    }
    assert.equal(await balance(), '100000');
    for (const kind of [
      'predicted-income',
      'receivable',
      'scheduled-debit',
      'payable',
    ]) {
      const expected = await json<CommandResult>(
        await call('planning/expected', {
          idempotencyKey: randomUUID(),
          accountId,
          currency: 'BRL',
          kind,
          amountMinor: '50000',
          dueAt: '2099-01-02T00:00:00.000Z',
          note: 'S3_EXPECTED_CANARY_04',
          source: 'user-confirmed',
        }),
      );
      assert.equal(
        await balance(),
        kind === 'predicted-income'
          ? '100000'
          : kind === 'receivable'
            ? '100000'
            : '150000',
      );
      assert.equal(
        (
          await h.request(
            `planning/expected/${expected.expectedId}/settle`,
            'POST',
            { idempotencyKey: randomUUID(), effectiveAt: actualAt },
            b.accessToken,
          )
        ).status,
        404,
      );
      const summary = await json<{
        settledBalanceMinor: string;
        projectedBalanceMinor: string;
        receivableMinor: string;
        payableMinor: string;
        predictedIncomeMinor: string;
        scheduledDebitMinor: string;
      }>(
        await h.request(
          `planning/expected/summary?accountId=${accountId}&through=2100-01-01T00:00:00.000Z`,
          'GET',
          undefined,
          a.accessToken,
        ),
      );
      assert.equal(summary.settledBalanceMinor, await balance());
      assert.equal(
        summary.projectedBalanceMinor,
        kind === 'predicted-income' || kind === 'receivable'
          ? '150000'
          : '100000',
      );
      assert.equal(
        summary.receivableMinor,
        kind === 'receivable' ? '50000' : '0',
      );
      assert.equal(summary.payableMinor, kind === 'payable' ? '50000' : '0');
      if (kind === 'receivable') {
        const settle = { idempotencyKey: randomUUID(), effectiveAt: actualAt };
        const responses = await Promise.all([
          call(`planning/expected/${expected.expectedId}/settle`, settle),
          call(`planning/expected/${expected.expectedId}/settle`, settle),
        ]);
        const first = await json<CommandResult>(responses[0]!);
        assert.deepEqual(await json(responses[1]!), first);
        assert.equal(await balance(), '150000');
        assert.equal(
          (
            await call(`planning/expected/${expected.expectedId}/settle`, {
              ...settle,
              idempotencyKey: randomUUID(),
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await call(`planning/expected/${expected.expectedId}/cancel`, {
              idempotencyKey: randomUUID(),
            })
          ).status,
          409,
        );
      }
      if (kind === 'payable') {
        const paid = await json<CommandResult>(
          await call(`planning/expected/${expected.expectedId}/settle`, {
            idempotencyKey: randomUUID(),
            effectiveAt: actualAt,
          }),
        );
        assert.equal(await balance(), '100000');
        await json(
          await call(`finance/events/${paid.eventIds[0]}/reverse`, {
            idempotencyKey: randomUUID(),
          }),
        );
        assert.equal(await balance(), '150000');
      } else if (kind !== 'receivable') {
        const command = { idempotencyKey: randomUUID() };
        const cancelled = await json<CommandResult>(
          await call(
            `planning/expected/${expected.expectedId}/cancel`,
            command,
          ),
        );
        assert.equal(cancelled.state, 'cancelled');
        assert.deepEqual(
          await json(
            await call(
              `planning/expected/${expected.expectedId}/cancel`,
              command,
            ),
          ),
          cancelled,
        );
      }
    }
    assert.deepEqual(
      (
        await json<{ entries: unknown[] }>(
          await h.request(
            `planning/expected?accountId=${accountId}`,
            'GET',
            undefined,
            b.accessToken,
          ),
        )
      ).entries,
      [],
    );
    const key = randomUUID(),
      income = {
        idempotencyKey: key,
        accountId,
        amountMinor: '50000',
        effectiveAt: actualAt,
        note: 'S3_POSTING_CANARY_04',
      };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => call('finance/postings/income', income)),
    );
    const received = await json<CommandResult>(results[0]!);
    for (const r of results.slice(1)) assert.deepEqual(await json(r), received);
    assert.equal(await balance(), '200000');
    assert.equal(
      (
        await call('finance/postings/income', {
          ...income,
          amountMinor: '50001',
        })
      ).status,
      409,
    );
    await Promise.all(
      Array.from({ length: 8 }, async () =>
        json(
          await call('finance/postings/income', {
            ...income,
            idempotencyKey: randomUUID(),
            amountMinor: '1',
          }),
        ),
      ),
    );
    assert.equal(await balance(), '200008');
    const expense = await json<CommandResult>(
      await call('finance/postings/expense', {
        ...income,
        idempotencyKey: randomUUID(),
        amountMinor: '12345',
      }),
    );
    assert.equal(await balance(), '187663');
    const reversals = await Promise.all([
      call(`finance/events/${expense.eventIds[0]}/reverse`, {
        idempotencyKey: randomUUID(),
      }),
      call(`finance/events/${expense.eventIds[0]}/reverse`, {
        idempotencyKey: randomUUID(),
      }),
    ]);
    assert.deepEqual(reversals.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await balance(), '200008');
    const correction = await json<CommandResult>(
      await call(`finance/events/${received.eventIds[0]}/correct`, {
        idempotencyKey: randomUUID(),
        kind: 'income',
        amountMinor: '25000',
        effectiveAt: actualAt,
        note: 'S3_CORRECTION_CANARY_04',
      }),
    );
    assert.equal(correction.eventIds.length, 2);
    assert.equal(await balance(), '175008');
    const history = await json<{
      events: Record<string, unknown>[];
      next: number | null;
    }>(
      await h.request(
        `finance/accounts/${accountId}/history?limit=2`,
        'GET',
        undefined,
        a.accessToken,
      ),
    );
    assert.equal(history.events.length, 2);
    assert.ok(history.next);
    const all = await json<{ events: Record<string, unknown>[] }>(
      await h.request(
        `finance/accounts/${accountId}/history`,
        'GET',
        undefined,
        a.accessToken,
      ),
    );
    assert.equal(all.events.length, 17);
    assert.ok(all.events.some((e) => e['reversalOf'] === received.eventIds[0]));
    assert.ok(
      all.events.some((e) => e['replacementOf'] === received.eventIds[0]),
    );
    assert.equal(
      (
        await h.request(
          `finance/accounts/${accountId}/history`,
          'GET',
          undefined,
          b.accessToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await h.request(
          'finance/postings/income',
          'POST',
          income,
          b.accessToken,
        )
      ).status,
      404,
    );
    assert.deepEqual(
      (
        await json<{ accounts: unknown[] }>(
          await h.request('finance/accounts', 'GET', undefined, b.accessToken),
        )
      ).accounts,
      [],
    );
    assert.equal(
      (
        await call('finance/postings/expense', {
          ...income,
          idempotencyKey: randomUUID(),
          effectiveAt: '2099-01-02T00:00:00.000Z',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call('finance/accounts', {
          ...input,
          idempotencyKey: randomUUID(),
          ownerId: b.principal.userId,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call('finance/postings/income', {
          ...income,
          idempotencyKey: randomUUID(),
          amountMinor: 0.1,
        })
      ).status,
      400,
    );
    const actualBucket = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a.principal.userId,
      ]);
      return (
        await tx.query<
          EncryptedRow & {
            account_id: string;
            currency: string;
            day: string;
            month: string;
            last_seq: string;
          }
        >(
          'SELECT * FROM app.finance_buckets WHERE user_id=$1 AND account_id=$2 AND day=$3',
          [a.principal.userId, accountId, '2026-01-02'],
        )
      ).rows[0]!;
    });
    const bucketValue = await h.module
      .get(EncryptedRecord)
      .open(
        a.principal,
        actualBucket,
        'finance.bucket',
        accountId,
        [
          accountId,
          actualBucket.currency,
          actualBucket.day,
          actualBucket.month,
          Number(actualBucket.last_seq),
        ],
        bucket,
      );
    assert.deepEqual(bucketValue, {
      contributionMinor: '75008',
      incomeMinor: '75008',
      expenseMinor: '0',
      rule: 1,
    });
    const encrypted = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a.principal.userId,
      ]);
      const payloads = [];
      for (const table of [
        'finance_accounts',
        'finance_events',
        'finance_receipts',
        'finance_buckets',
        'finance_checkpoints',
        'finance_streams',
        'planning_expected',
        'planning_expected_events',
      ])
        payloads.push(
          ...(
            await tx.query(
              `SELECT payload FROM app.${table} WHERE user_id=$1`,
              [a.principal.userId],
            )
          ).rows,
        );
      return JSON.stringify(payloads);
    });
    for (const secret of [
      'S3_ACCOUNT_CANARY_04',
      'S3_POSTING_CANARY_04',
      'S3_EXPECTED_CANARY_04',
      'S3_CORRECTION_CANARY_04',
      '"balanceMinor"',
      '"amountMinor"',
    ]) {
      assert.equal(encrypted.includes(secret), false);
      assert.equal(JSON.stringify(h.lines).includes(secret), false);
    }
    const config = loadConfig().database,
      passFile = join(
        process.env['CRYPTO_CONTROL_DIRECTORY']!,
        `pgpass-${randomUUID()}`,
      );
    const escape = (value: string) =>
      value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
    writeFileSync(
      passFile,
      [
        config.host,
        String(config.port),
        config.database,
        config.user,
        config.password,
      ]
        .map(escape)
        .join(':') + '\n',
      { mode: 0o600 },
    );
    try {
      const dump = spawnSync(
        '/opt/forja-pg-tools/bin/pg_dump',
        [
          '--host',
          config.host,
          '--port',
          String(config.port),
          '--username',
          config.user,
          '--dbname',
          config.database,
          '--data-only',
          '--inserts',
          '--enable-row-security',
          '--table=app.finance_*',
          '--table=app.planning_*',
        ],
        {
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            LD_LIBRARY_PATH: '/opt/forja-pg-tools/lib',
            PGPASSFILE: passFile,
            PGOPTIONS: `-c forja.user_id=${a.principal.userId}`,
          },
        },
      );
      assert.equal(dump.status, 0, 'real pg_dump succeeds under owner RLS');
      assert.ok(dump.stdout.includes('INSERT INTO app.finance_events'));
      for (const secret of [
        'S3_ACCOUNT_CANARY_04',
        'S3_POSTING_CANARY_04',
        'S3_EXPECTED_CANARY_04',
        'S3_CORRECTION_CANARY_04',
        '"balanceMinor"',
        '"amountMinor"',
        '"deltaMinor"',
      ])
        assert.equal(dump.stdout.includes(secret), false);
    } finally {
      unlinkSync(passFile);
    }
    assert.ok(h.platform.lifecycle.anchorHead(a.principal.userId));
    const rls = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        b.principal.userId,
      ]);
      return tx.query('SELECT id FROM app.finance_accounts WHERE user_id=$1', [
        a.principal.userId,
      ]);
    });
    assert.equal(rls.rowCount, 0);
    await assert.rejects(
      h.db.transaction(async (tx) => {
        await tx.query("SELECT set_config('forja.user_id',$1,true)", [
          a.principal.userId,
        ]);
        await tx.query(
          'UPDATE app.finance_events SET effective_at=$2 WHERE user_id=$1',
          [a.principal.userId, actualAt],
        );
      }),
    );
    const saved = await json<CommandResult>(
      await h.request(
        'finance/accounts',
        'POST',
        {
          ...input,
          idempotencyKey: randomUUID(),
          name: 'Zero savings',
          type: 'savings',
          currency: 'JPY',
          openingMinor: '0',
        },
        b.accessToken,
      ),
    );
    const closed = await json<CommandResult>(
      await h.request(
        `finance/accounts/${saved.accountId}/close`,
        'POST',
        { idempotencyKey: randomUUID() },
        b.accessToken,
      ),
    );
    assert.equal(closed.state, 'closed');
    assert.equal(
      (
        await h.request(
          'finance/postings/income',
          'POST',
          {
            ...income,
            idempotencyKey: randomUUID(),
            accountId: saved.accountId,
            amountMinor: '1',
          },
          b.accessToken,
        )
      ).status,
      409,
    );
    assert.equal(
      (await h.request('me', 'DELETE', {}, a.accessToken)).status,
      204,
    );
    const erased = await h.owner.query(
      'SELECT count(*)::int AS n FROM app.user_data_keys WHERE user_id=$1',
      [a.principal.userId],
    );
    assert.equal(erased.rows[0].n, 0);
  } finally {
    await h.close();
  }
});
test('faults after each financial write and before commit roll back actuals/expectations while nonce reservations burn', async (context) => {
  const h = await harness();
  try {
    const a = await h.login('finance-fault'),
      finance = h.module.get(FinanceService);
    const opened = await finance.createAccount(a.principal, randomUUID(), {
      name: 'Fault account',
      type: 'cash',
      currency: 'BRL',
      openingMinor: '100000',
      openedAt: openingAt,
      source: 'user-confirmed',
    });
    const dbTransaction = h.db.transaction.bind(h.db),
      accountId = opened.accountId!;
    const controlDb = new DatabaseSync(
      join(process.env['CRYPTO_CONTROL_DIRECTORY']!, 'lifecycle.sqlite'),
      { readOnly: true },
    );
    const counter = () =>
      Number(
        controlDb
          .prepare("SELECT count FROM keys WHERE user_id=? AND state='active'")
          .get(a.principal.userId)?.count,
      );
    const records = h.module.get(EncryptedRecord),
      seal = records.seal.bind(records);
    for (const stage of [
      'seal.before',
      'seal.after',
      'UPDATE app.finance_accounts',
      'INSERT INTO app.finance_events',
      'INSERT INTO app.finance_buckets',
      'INSERT INTO app.finance_checkpoints',
      'INSERT INTO app.finance_anchor_outbox',
      'INSERT INTO app.finance_receipts',
      'UPDATE app.finance_streams',
      'beforeCommit',
    ]) {
      const key = randomUUID(),
        before = await finance.accounts(a.principal, undefined, 100),
        beforeCount = counter();
      if (stage.startsWith('seal.'))
        context.mock.method(
          records,
          'seal',
          async (...args: Parameters<typeof records.seal>) => {
            if (stage === 'seal.before')
              throw new PlatformFailure('unavailable');
            await seal(...args);
            throw new PlatformFailure('unavailable');
          },
        );
      context.mock.method(
        h.db,
        'transaction',
        async (operation: (tx: Transaction) => Promise<unknown>) =>
          dbTransaction(async (tx) => {
            let touched = false;
            tx.beforeCommit(() => {
              if (stage === 'beforeCommit' && touched)
                throw new PlatformFailure('unavailable');
            });
            const wrapped: Transaction = {
              beforeCommit: tx.beforeCommit,
              query: async <R extends import('pg').QueryResultRow>(
                sql: string,
                params?: readonly unknown[],
              ) => {
                const result = await tx.query<R>(sql, params);
                if (sql.startsWith('INSERT INTO app.finance_events'))
                  touched = true;
                if (sql.startsWith(stage))
                  throw new PlatformFailure('unavailable');
                return result;
              },
            };
            return operation(wrapped);
          }),
      );
      await assert.rejects(
        finance.posting(a.principal, key, 'income', {
          accountId,
          amountMinor: '50000',
          effectiveAt: actualAt,
          note: 'S3_FAILURE_CANARY_04',
        }),
      );
      context.mock.restoreAll();
      if (stage === 'seal.before') assert.equal(counter(), beforeCount);
      else assert.ok(counter() > beforeCount);
      const state = await finance.accounts(a.principal, undefined, 100);
      assert.equal(state.accounts[0]!.balanceMinor, '100000');
      assert.equal(state.cursor, before.cursor);
      const posted = await finance.posting(a.principal, key, 'income', {
        accountId,
        amountMinor: '1',
        effectiveAt: actualAt,
        note: 'Retry after rollback',
      });
      assert.equal(posted.eventIds.length, 1);
      await finance.adjust(a.principal, randomUUID(), posted.eventIds[0]!);
      // Baseline remains unchanged; subsequent iterations target the next stream cursor.
      const snapshot = await finance.accounts(a.principal, undefined, 100);
      assert.equal(snapshot.accounts[0]!.balanceMinor, '100000');
    }
    context.mock.restoreAll();
    controlDb.close();
    const expected = await json<CommandResult>(
      await h.request(
        'planning/expected',
        'POST',
        {
          idempotencyKey: randomUUID(),
          accountId,
          currency: 'BRL',
          dueAt: '2099-01-01T00:00:00.000Z',
          kind: 'receivable',
          amountMinor: '50000',
          note: 'Settlement rollback',
          source: 'user-confirmed',
        },
        a.accessToken,
      ),
    );
    context.mock.method(
      h.db,
      'transaction',
      async (operation: (tx: Transaction) => Promise<unknown>) =>
        dbTransaction(async (tx) => {
          return operation({
            beforeCommit: tx.beforeCommit,
            query: async <R extends import('pg').QueryResultRow>(
              sql: string,
              params?: readonly unknown[],
            ) => {
              const result = await tx.query<R>(sql, params);
              if (sql.startsWith('UPDATE app.planning_expected'))
                throw new PlatformFailure('unavailable');
              return result;
            },
          });
        }),
    );
    const settle = { idempotencyKey: randomUUID(), effectiveAt: actualAt };
    assert.equal(
      (
        await h.request(
          `planning/expected/${expected.expectedId}/settle`,
          'POST',
          settle,
          a.accessToken,
        )
      ).status,
      503,
    );
    context.mock.restoreAll();
    const unchanged = await finance.accounts(a.principal, undefined, 100);
    assert.equal(unchanged.accounts[0]!.balanceMinor, '100000');
    const pending = await json<{ entries: { state: string }[] }>(
      await h.request(
        `planning/expected?accountId=${accountId}`,
        'GET',
        undefined,
        a.accessToken,
      ),
    );
    assert.equal(pending.entries[0]!.state, 'pending');
    await json(
      await h.request(
        `planning/expected/${expected.expectedId}/settle`,
        'POST',
        settle,
        a.accessToken,
      ),
    );
    assert.equal(
      (await finance.accounts(a.principal, undefined, 100)).accounts[0]!
        .balanceMinor,
      '150000',
    );
    assert.equal(
      JSON.stringify(h.lines).includes('S3_FAILURE_CANARY_04'),
      false,
    );
  } finally {
    context.mock.restoreAll();
    await h.close();
  }
});
test('AAD tampering, foreign ciphertext, stale projections, anchored rollback and journal outage fail safely', async (context) => {
  const h = await harness();
  try {
    const a = await h.login('finance-integrity-a'),
      b = await h.login('finance-integrity-b'),
      finance = h.module.get(FinanceService);
    const input = {
      name: 'Integrity account',
      type: 'cash' as const,
      currency: 'BRL' as const,
      openingMinor: '100000',
      openedAt: openingAt,
      source: 'user-confirmed' as const,
    };
    const opened = await finance.createAccount(
        a.principal,
        randomUUID(),
        input,
      ),
      foreign = await finance.createAccount(b.principal, randomUUID(), input),
      accountId = opened.accountId!;
    async function ownerQuery(sql: string, params: unknown[] = []) {
      return h.db.transaction(async (tx) => {
        await tx.query("SELECT set_config('forja.user_id',$1,true)", [
          a.principal.userId,
        ]);
        return tx.query(sql, params);
      });
    }
    const snapshot = (
      await ownerQuery(
        'SELECT * FROM app.finance_accounts WHERE user_id=$1 AND id=$2',
        [a.principal.userId, accountId],
      )
    ).rows[0]!;
    const streamSnapshot = (
      await ownerQuery('SELECT * FROM app.finance_streams WHERE user_id=$1', [
        a.principal.userId,
      ])
    ).rows[0]!;
    await ownerQuery(
      "UPDATE app.finance_accounts SET currency='USD' WHERE user_id=$1 AND id=$2",
      [a.principal.userId, accountId],
    )
      .then(() => assert.fail('currency FK must reject'))
      .catch((error) => assert.ok(error instanceof PlatformFailure));
    await ownerQuery(
      "UPDATE app.finance_accounts SET state='closed' WHERE user_id=$1 AND id=$2",
      [a.principal.userId, accountId],
    );
    await assert.rejects(finance.accounts(a.principal, undefined, 100));
    await ownerQuery(
      "UPDATE app.finance_accounts SET state='active' WHERE user_id=$1 AND id=$2",
      [a.principal.userId, accountId],
    );
    const foreignPayload = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        b.principal.userId,
      ]);
      return (
        await tx.query(
          'SELECT payload FROM app.finance_accounts WHERE user_id=$1 AND id=$2',
          [b.principal.userId, foreign.accountId],
        )
      ).rows[0]!.payload;
    });
    await ownerQuery(
      'UPDATE app.finance_accounts SET payload=$3 WHERE user_id=$1 AND id=$2',
      [a.principal.userId, accountId, foreignPayload],
    );
    await assert.rejects(finance.accounts(a.principal, undefined, 100));
    await ownerQuery(
      'UPDATE app.finance_accounts SET payload=$3 WHERE user_id=$1 AND id=$2',
      [a.principal.userId, accountId, snapshot.payload],
    );
    const head = h.platform.lifecycle.anchorHead(a.principal.userId)!;
    context.mock.method(h.platform.lifecycle, 'anchor', () => {
      throw new PlatformFailure('unavailable');
    });
    const commandKey = randomUUID();
    const posting = {
      accountId,
      amountMinor: '50000',
      effectiveAt: actualAt,
      note: 'Journal outage',
    };
    const committed = await finance.posting(
      a.principal,
      commandKey,
      'income',
      posting,
    );
    assert.equal(committed.seq, 2);
    assert.equal(
      h.platform.lifecycle.anchorHead(a.principal.userId)!.seq,
      head.seq,
    );
    assert.equal(
      (await finance.accounts(a.principal, undefined, 100)).accounts[0]!
        .balanceMinor,
      '150000',
    );
    assert.ok(h.lines.some((line) => line.includes('finance.anchor')));
    context.mock.restoreAll();
    await finance.anchorPending(a.principal);
    assert.equal(h.platform.lifecycle.anchorHead(a.principal.userId)!.seq, 2);
    const current = (
      await ownerQuery(
        'SELECT * FROM app.finance_accounts WHERE user_id=$1 AND id=$2',
        [a.principal.userId, accountId],
      )
    ).rows[0]!;
    await ownerQuery(
      'UPDATE app.finance_accounts SET payload=$3,revision=$4,last_seq=$5 WHERE user_id=$1 AND id=$2',
      [
        a.principal.userId,
        accountId,
        snapshot.payload,
        snapshot.revision,
        snapshot.last_seq,
      ],
    );
    await assert.rejects(finance.accounts(a.principal, undefined, 100));
    await ownerQuery(
      'UPDATE app.finance_accounts SET payload=$3,revision=$4,last_seq=$5 WHERE user_id=$1 AND id=$2',
      [
        a.principal.userId,
        accountId,
        current.payload,
        current.revision,
        current.last_seq,
      ],
    );
    const currentStream = (
      await ownerQuery('SELECT * FROM app.finance_streams WHERE user_id=$1', [
        a.principal.userId,
      ])
    ).rows[0]!;
    await ownerQuery(
      'UPDATE app.finance_streams SET payload=$2,revision=$3,seq=$4 WHERE user_id=$1',
      [
        a.principal.userId,
        streamSnapshot.payload,
        streamSnapshot.revision,
        streamSnapshot.seq,
      ],
    );
    await assert.rejects(finance.accounts(a.principal, undefined, 100));
    await ownerQuery(
      'UPDATE app.finance_streams SET payload=$2,revision=$3,seq=$4 WHERE user_id=$1',
      [
        a.principal.userId,
        currentStream.payload,
        currentStream.revision,
        currentStream.seq,
      ],
    );
    assert.deepEqual(
      await finance.posting(a.principal, commandKey, 'income', posting),
      committed,
    );
    const bucketSnapshot = (
      await ownerQuery(
        'SELECT * FROM app.finance_buckets WHERE user_id=$1 AND account_id=$2 AND day=$3',
        [a.principal.userId, accountId, '2026-01-02'],
      )
    ).rows[0]!;
    await ownerQuery(
      'DELETE FROM app.finance_buckets WHERE user_id=$1 AND account_id=$2 AND day=$3',
      [a.principal.userId, accountId, '2026-01-02'],
    );
    const repairKey = randomUUID();
    await assert.rejects(
      finance.posting(a.principal, repairKey, 'income', {
        ...posting,
        amountMinor: '1',
      }),
    );
    assert.equal(
      (await finance.accounts(a.principal, undefined, 100)).accounts[0]!
        .balanceMinor,
      '150000',
    );
    await ownerQuery(
      'INSERT INTO app.finance_buckets VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        bucketSnapshot.user_id,
        bucketSnapshot.account_id,
        bucketSnapshot.currency,
        bucketSnapshot.day,
        bucketSnapshot.month,
        bucketSnapshot.last_seq,
        bucketSnapshot.revision,
        bucketSnapshot.dek_id,
        bucketSnapshot.dek_version,
        bucketSnapshot.payload,
      ],
    );
    await finance.posting(a.principal, repairKey, 'income', {
      ...posting,
      amountMinor: '1',
    });
    assert.equal(
      (await finance.accounts(a.principal, undefined, 100)).accounts[0]!
        .balanceMinor,
      '150001',
    );
    const expected = await json<CommandResult>(
      await h.request(
        'planning/expected',
        'POST',
        {
          idempotencyKey: randomUUID(),
          accountId,
          currency: 'BRL',
          dueAt: actualAt,
          kind: 'receivable',
          amountMinor: '1',
          note: 'Replay expected state',
          source: 'user-confirmed',
        },
        a.accessToken,
      ),
    );
    const overdue = await json<{ entries: { status: string }[] }>(
      await h.request(
        `planning/expected?accountId=${accountId}`,
        'GET',
        undefined,
        a.accessToken,
      ),
    );
    assert.equal(overdue.entries[0]!.status, 'overdue-receivable');
    const overdueSummary = await json<{
      overdueReceivableMinor: string;
      settledBalanceMinor: string;
      projectedBalanceMinor: string;
    }>(
      await h.request(
        `planning/expected/summary?accountId=${accountId}&through=2100-01-01T00:00:00.000Z`,
        'GET',
        undefined,
        a.accessToken,
      ),
    );
    assert.equal(overdueSummary.overdueReceivableMinor, '1');
    assert.equal(overdueSummary.settledBalanceMinor, '150001');
    assert.equal(overdueSummary.projectedBalanceMinor, '150002');
    const expectedSnapshot = (
      await ownerQuery(
        'SELECT * FROM app.planning_expected WHERE user_id=$1 AND id=$2',
        [a.principal.userId, expected.expectedId],
      )
    ).rows[0]!;
    await json(
      await h.request(
        `planning/expected/${expected.expectedId}/settle`,
        'POST',
        { idempotencyKey: randomUUID(), effectiveAt: actualAt },
        a.accessToken,
      ),
    );
    const settledSnapshot = (
      await ownerQuery(
        'SELECT * FROM app.planning_expected WHERE user_id=$1 AND id=$2',
        [a.principal.userId, expected.expectedId],
      )
    ).rows[0]!;
    await ownerQuery(
      'UPDATE app.planning_expected SET state=$3,settlement_id=$4,revision=$5,payload=$6 WHERE user_id=$1 AND id=$2',
      [
        a.principal.userId,
        expected.expectedId,
        expectedSnapshot.state,
        expectedSnapshot.settlement_id,
        expectedSnapshot.revision,
        expectedSnapshot.payload,
      ],
    );
    assert.equal(
      (
        await h.request(
          `planning/expected?accountId=${accountId}`,
          'GET',
          undefined,
          a.accessToken,
        )
      ).status,
      503,
    );
    assert.equal(
      (
        await h.request(
          `planning/expected/${expected.expectedId}/settle`,
          'POST',
          { idempotencyKey: randomUUID(), effectiveAt: actualAt },
          a.accessToken,
        )
      ).status,
      503,
    );
    await ownerQuery(
      'UPDATE app.planning_expected SET state=$3,settlement_id=$4,revision=$5,payload=$6 WHERE user_id=$1 AND id=$2',
      [
        a.principal.userId,
        expected.expectedId,
        settledSnapshot.state,
        settledSnapshot.settlement_id,
        settledSnapshot.revision,
        settledSnapshot.payload,
      ],
    );
    context.mock.method(finance, 'ready', async () => false);
    assert.equal(
      (await fetch((await h.app.getUrl()) + '/health/ready')).status,
      503,
    );
    assert.equal(
      (await fetch((await h.app.getUrl()) + '/health/live')).status,
      200,
    );
    context.mock.restoreAll();
    const bound = await ownerQuery(
      'EXPLAIN SELECT id FROM app.finance_events WHERE user_id=$1 AND account_id=$2 AND seq>0 ORDER BY seq LIMIT 100',
      [a.principal.userId, accountId],
    );
    assert.ok(bound.rows.length > 0);
  } finally {
    context.mock.restoreAll();
    await h.close();
  }
});

test('bounded expected totals include overdue obligations, reject truncation and never aggregate different currencies', async () => {
  const h = await harness();
  try {
    const a = await h.login('finance-summary'),
      finance = h.module.get(FinanceService),
      opened = await finance.createAccount(a.principal, randomUUID(), {
        name: 'Summary account',
        type: 'cash',
        currency: 'BRL',
        openingMinor: '100000',
        openedAt: openingAt,
        source: 'user-confirmed',
      }),
      accountId = opened.accountId!;
    const expected = await json<CommandResult>(
      await h.request(
        'planning/expected',
        'POST',
        {
          idempotencyKey: randomUUID(),
          accountId,
          currency: 'BRL',
          dueAt: actualAt,
          kind: 'payable',
          amountMinor: '50000',
          note: 'Overdue payable',
          source: 'user-confirmed',
        },
        a.accessToken,
      ),
    );
    const path = `planning/expected/summary?accountId=${accountId}&through=2100-01-01T00:00:00.000Z`;
    const summary = await json<{
      settledBalanceMinor: string;
      projectedBalanceMinor: string;
      overduePayableMinor: string;
      payableMinor: string;
      expectedInputs: unknown[];
    }>(await h.request(path, 'GET', undefined, a.accessToken));
    assert.equal(summary.settledBalanceMinor, '100000');
    assert.equal(summary.projectedBalanceMinor, '50000');
    assert.equal(summary.payableMinor, '50000');
    assert.equal(summary.overduePayableMinor, '50000');
    assert.equal(summary.expectedInputs.length, 1);
    const listing = await json<{ entries: { status: string }[] }>(
      await h.request(
        `planning/expected?accountId=${accountId}`,
        'GET',
        undefined,
        a.accessToken,
      ),
    );
    assert.equal(listing.entries[0]!.status, 'overdue-payable');
    // A test-only metadata population proves the guard rejects >1,000 before decrypting incomplete inputs.
    // These deliberately unauthenticatable clones are never consumed as financial evidence.
    await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a.principal.userId,
      ]);
      await tx.query(
        'INSERT INTO app.planning_expected SELECT user_id,gen_random_uuid(),account_id,currency,due_at,state,settlement_id,revision,dek_id,dek_version,payload FROM app.planning_expected CROSS JOIN generate_series(1,1000) WHERE user_id=$1 AND id=$2',
        [a.principal.userId, expected.expectedId],
      );
    });
    const bounded = await h.request(path, 'GET', undefined, a.accessToken);
    assert.equal(bounded.status, 422);
    assert.deepEqual(await bounded.json(), { code: 'BOUNDED_PERIOD_REQUIRED' });
    assert.equal(
      (
        await h.request(
          'planning/expected',
          'POST',
          {
            idempotencyKey: randomUUID(),
            accountId,
            currency: 'USD',
            dueAt: actualAt,
            kind: 'receivable',
            amountMinor: '1',
            note: 'Currency mismatch',
            source: 'user-confirmed',
          },
          a.accessToken,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await h.request(
          `planning/expected/summary?accountId=${accountId}&through=${openingAt}`,
          'GET',
          undefined,
          a.accessToken,
        )
      ).status,
      400,
    );
  } finally {
    await h.close();
  }
});
