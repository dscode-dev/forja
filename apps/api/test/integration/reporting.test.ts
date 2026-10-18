import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { harness } from '../fixtures/identity-harness';
import { ReportingService } from '../../src/reporting/reporting.service';
import { FinanceService } from '../../src/finance/finance.service';
import { WorkService } from '../../src/work/work.service';
import { GoalsService } from '../../src/planning/goals/goals.service';
import { GameService } from '../../src/game/game.service';
import { Database, Transaction } from '../../src/platform/database';
const profile = {
  workStatus: 'employed',
  occupation: 'REPORT_WORK_CANARY',
  workModel: 'employment',
  earningModel: 'FIXED_MONTHLY',
  currency: 'BRL',
  components: [{ kind: 'FIXED_MONTHLY', amountMinor: '310000' }],
  availability: {
    availableMinutesPerDay: 240,
    preferredWeekdays: [1, 2, 3, 4, 5],
    maximumMinutesPerWeek: 2400,
    committedMinutesPerWeek: 0,
  },
  skills: [],
  desiredDirection: null,
  careerTarget: null,
  notes: null,
};
const daily = (accountId: string) => ({
  accountId,
  type: 'DAILY',
  from: '2026-03-08',
  through: '2026-03-08',
});
test('real encrypted Chronicles: timezone boundaries, exact period flows/comparisons, planned separation, frozen source context, correction versions, owner isolation and erasure', async (t) => {
  const h = await harness();
  try {
    const a = await h.login('report-owner'),
      b = await h.login('report-foreign'),
      f = h.module.get(FinanceService),
      r = h.module.get(ReportingService),
      w = h.module.get(WorkService),
      g = h.module.get(GoalsService),
      game = h.module.get(GameService);
    const me = await h.identity.profile(a.principal);
    const changed = await h.request(
      'me/profile',
      'PUT',
      {
        revision: me.revision,
        profile: {
          displayName: 'REPORT_IDENTITY_CANARY',
          locale: 'pt-BR',
          timezone: 'America/New_York',
          preferredCurrency: 'BRL',
          onboardingState: 'complete',
        },
      },
      a.accessToken,
    );
    assert.equal(changed.status, 200);
    const accountId = (
      await f.createAccount(a.principal, randomUUID(), {
        name: 'REPORT_ACCOUNT_CANARY',
        type: 'savings',
        currency: 'BRL',
        openingMinor: '1000',
        openedAt: '2026-01-01T00:00:00.000Z',
        source: 'user-confirmed',
      })
    ).accountId!;
    await f.posting(a.principal, randomUUID(), 'income', {
      accountId,
      amountMinor: '200',
      effectiveAt: '2026-03-07T10:00:00.000Z',
      note: 'REPORT_NOTE_CANARY',
    });
    await f.posting(a.principal, randomUUID(), 'income', {
      accountId,
      amountMinor: '100',
      effectiveAt: '2026-03-08T04:59:59.999Z',
      note: 'previous-local-day',
    });
    const actual = await f.posting(a.principal, randomUUID(), 'income', {
      accountId,
      amountMinor: '700',
      effectiveAt: '2026-03-08T05:00:00.000Z',
      note: 'included-at-start',
    });
    await f.posting(a.principal, randomUUID(), 'expense', {
      accountId,
      amountMinor: '250',
      effectiveAt: '2026-03-09T03:59:59.999Z',
      note: 'included-before-end',
    });
    await f.posting(a.principal, randomUUID(), 'income', {
      accountId,
      amountMinor: '900',
      effectiveAt: '2026-03-09T04:00:00.000Z',
      note: 'excluded-at-end',
    });
    for (const [kind, amountMinor] of [
      ['predicted-income', '8000'],
      ['receivable', '300'],
      ['payable', '120'],
      ['scheduled-debit', '50'],
    ])
      assert.equal(
        (
          await h.request(
            'planning/expected',
            'POST',
            {
              idempotencyKey: randomUUID(),
              accountId,
              currency: 'BRL',
              dueAt: '2026-03-08T12:00:00.000Z',
              kind,
              amountMinor,
              note: 'REPORT_EXPECTED_CANARY',
              source: 'user-confirmed',
            },
            a.accessToken,
          )
        ).status,
        200,
      );
    const goal = await g.create(a.principal, randomUUID(), {
      title: 'REPORT_GOAL_CANARY',
      description: null,
      targetMinor: '999999',
      currency: 'BRL',
      startDate: '2026-01-01',
      deadline: '2027-01-01',
      fundingAccountId: accountId,
      retainedEarningsBasisPoints: 10000,
    });
    await game.assign(a.principal, randomUUID(), 'RESERVE_TARGET', goal.id, 1);
    const wm = await game.assign(
      a.principal,
      randomUUID(),
      'WORK_PROFILE',
      null,
      null,
    );
    await w.replace(a.principal, 0, profile);
    await game.evaluate(a.principal, wm.id);
    await g.generate(a.principal, goal.id, randomUUID(), 1, null, null);
    const before = await f.accounts(a.principal, undefined, 100),
      key = randomUUID(),
      start = performance.now(),
      v = await r.generate(a.principal, key, daily(accountId));
    t.diagnostic(
      `Representative 23-hour report generation: ${(performance.now() - start).toFixed(1)}ms; selected inputs=${v.inputsRead}`,
    );
    assert.deepEqual(v.settled, {
      incomeMinor: '700',
      expenseMinor: '250',
      netMinor: '450',
      openingMinor: '1300',
      closingMinor: '1750',
      baselineChangeMinor: '0',
    });
    assert.equal(v.previous.incomeMinor, '300');
    assert.equal(v.comparisons.income.deltaMinor, '400');
    assert.equal(v.comparisons.income.percentageBasisPoints, '13333');
    assert.equal(v.planning.predictedIncomeMinor, '8000');
    assert.equal(v.planning.plannedNetMinor, '8130');
    assert.equal(v.goal?.revision, 1);
    assert.equal(v.work?.revision, 1);
    assert.ok(v.goal?.calculation?.calculationId);
    assert.equal(v.reserve?.goalId, goal.id);
    assert.equal(v.game.xp, 20);
    assert.equal(v.game.xpGained, 0);
    assert.deepEqual(await f.accounts(a.principal, undefined, 100), before);
    const duplicates = await Promise.all(
      Array.from({ length: 8 }, () =>
        r.generate(a.principal, key, daily(accountId)),
      ),
    );
    assert.ok(
      duplicates.every((x) => x.id === key && x.generation === v.generation),
    );
    await assert.rejects(
      r.generate(a.principal, key, { ...daily(accountId), type: 'MONTHLY' }),
    );
    assert.equal(
      (
        await h.request(
          'reports/chronicles/' + key,
          'GET',
          undefined,
          b.accessToken,
        )
      ).status,
      404,
    );
    const response = await h.request(
      'reports/chronicles/' + key,
      'GET',
      undefined,
      a.accessToken,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await w.replace(a.principal, 1, {
      ...profile,
      components: [{ kind: 'FIXED_MONTHLY', amountMinor: '620000' }],
    });
    await f.adjust(a.principal, randomUUID(), actual.eventIds[0]!);
    assert.deepEqual(await r.get(a.principal, key), v);
    const next = await r.generate(a.principal, randomUUID(), daily(accountId));
    assert.equal(next.settled.incomeMinor, '0');
    assert.equal(next.settled.netMinor, '-250');
    assert.equal(next.settled.closingMinor, '1050');
    assert.equal(next.work?.revision, 2);
    assert.equal(next.goal?.calculation?.stale, true);
    assert.equal(next.generation, v.generation + 1);
    for (const type of ['WEEKLY', 'MONTHLY', 'CUSTOM']) {
      const reportStarted = performance.now();
      const p = await r.generate(a.principal, randomUUID(), {
        ...daily(accountId),
        type,
        ...(type === 'CUSTOM'
          ? { from: '2026-01-01', through: '2026-12-31' }
          : {}),
      });
      assert.equal(p.reportVersion, 1);
      t.diagnostic(
        `Sparse fixture ${type} generation: ${(performance.now() - reportStarted).toFixed(1)}ms; selected inputs=${p.inputsRead}`,
      );
    }
    const compact = await r.alchemistFacts(a.principal, key);
    assert.ok(!JSON.stringify(compact).includes('CANARY'));
    assert.ok(!JSON.stringify(compact).includes(accountId));
    const dump = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a.principal.userId,
      ]);
      return (
        await tx.query(
          'SELECT row_to_json(s)::text AS data FROM app.report_snapshots s UNION ALL SELECT row_to_json(r)::text AS data FROM app.report_requests r',
        )
      ).rows;
    });
    assert.ok(dump.length >= 5);
    assert.ok(
      dump.every(
        (x) =>
          !String(x['data']).includes('incomeMinor') &&
          !String(x['data']).includes('CANARY'),
      ),
    );
    await assert.rejects(
      h.db.transaction(async (tx) => {
        await tx.query("SELECT set_config('forja.user_id',$1,true)", [
          a.principal.userId,
        ]);
        await tx.query(
          'UPDATE app.report_snapshots SET payload=payload WHERE user_id=$1',
          [a.principal.userId],
        );
      }),
    );
    const originalCipher = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a.principal.userId,
      ]);
      return (
        await tx.query<{ id: string; payload: string }>(
          'SELECT id,payload FROM app.report_snapshots WHERE user_id=$1 AND id=ANY($2::uuid[])',
          [a.principal.userId, [key, next.id]],
        )
      ).rows;
    });
    await h.owner.query(
      'ALTER TABLE app.report_snapshots DISABLE TRIGGER report_snapshots_immutable',
    );
    try {
      await h.db.transaction(async (tx) => {
        await tx.query("SELECT set_config('forja.user_id',$1,true)", [
          a.principal.userId,
        ]);
        await tx.query(
          'UPDATE app.report_snapshots SET payload=$3 WHERE user_id=$1 AND id=$2',
          [
            a.principal.userId,
            key,
            originalCipher.find((x) => x.id === next.id)!.payload,
          ],
        );
      });
      await assert.rejects(
        r.get(a.principal, key),
        (e: unknown) =>
          e instanceof Error && 'code' in e && e.code === 'integrity',
      );
    } finally {
      await h.db.transaction(async (tx) => {
        await tx.query("SELECT set_config('forja.user_id',$1,true)", [
          a.principal.userId,
        ]);
        await tx.query(
          'UPDATE app.report_snapshots SET payload=$3 WHERE user_id=$1 AND id=$2',
          [
            a.principal.userId,
            key,
            originalCipher.find((x) => x.id === key)!.payload,
          ],
        );
      });
      await h.owner.query(
        'ALTER TABLE app.report_snapshots ENABLE TRIGGER report_snapshots_immutable',
      );
    }
    const owned = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        b.principal.userId,
      ]);
      return (
        await tx.query('SELECT id FROM app.report_snapshots WHERE user_id=$1', [
          a.principal.userId,
        ])
      ).rowCount;
    });
    assert.equal(owned, 0);
    const retrieval = performance.now();
    await r.get(a.principal, key);
    t.diagnostic(
      `Frozen artifact retrieval: ${(performance.now() - retrieval).toFixed(1)}ms; no source recomputation`,
    );
    const usd = (
      await f.createAccount(a.principal, randomUUID(), {
        name: 'USD scope',
        type: 'cash',
        currency: 'USD',
        openingMinor: '100',
        openedAt: '2026-01-01T00:00:00.000Z',
        source: 'user-confirmed',
      })
    ).accountId!;
    await g.revise(a.principal, goal.id, randomUUID(), 1, {
      title: 'new currency',
      description: null,
      targetMinor: '99999',
      currency: 'USD',
      startDate: '2026-01-01',
      deadline: '2027-01-01',
      fundingAccountId: usd,
      retainedEarningsBasisPoints: 10000,
    });
    const separate = await r.generate(a.principal, randomUUID(), daily(usd));
    assert.equal(separate.finance.currency, 'USD');
    assert.equal(separate.work?.currency, 'BRL');
    assert.equal(separate.work?.incomeMinusCapacityMinor, null);
    assert.equal(separate.goal?.calculation?.currency, 'BRL');
    assert.equal(separate.goal?.calculation?.stale, true);
    assert.equal(separate.reserve, null);
    assert.ok(!h.lines.join('').includes('CANARY'));
    await h.identity.deletion(a.principal);
    const left = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a.principal.userId,
      ]);
      return tx.query(
        'SELECT (SELECT count(*) FROM app.report_requests WHERE user_id=$1)::int AS requests,(SELECT count(*) FROM app.report_snapshots WHERE user_id=$1)::int AS snapshots',
        [a.principal.userId],
      );
    });
    assert.deepEqual(left.rows[0], { requests: 0, snapshots: 0 });
  } finally {
    await h.close();
  }
});
test('real report concurrency, atomic rollback, partial baseline, expired artifact cleanup and safe replay denial', async () => {
  const h = await harness();
  try {
    const a = await h.login('report-races'),
      f = h.module.get(FinanceService),
      r = h.module.get(ReportingService),
      accountId = (
        await f.createAccount(a.principal, randomUUID(), {
          name: 'report',
          type: 'cash',
          currency: 'BRL',
          openingMinor: '500',
          openedAt: '2026-03-08T12:00:00.000Z',
          source: 'user-confirmed',
        })
      ).accountId!;
    const key = randomUUID(),
      results = await Promise.all(
        Array.from({ length: 8 }, () =>
          r.generate(a.principal, key, daily(accountId)),
        ),
      );
    assert.equal(new Set(results.map((x) => x.generation)).size, 1);
    assert.equal(results[0]!.settled.baselineChangeMinor, '500');
    assert.equal(results[0]!.settled.incomeMinor, '0');
    const fault = randomUUID(),
      db = h.module.get(Database),
      original = db.transaction.bind(db);
    db.transaction = async (operation) =>
      original(async (tx) => {
        tx.beforeCommit(async () => {
          const found = await tx.query(
            'SELECT id FROM app.report_snapshots WHERE user_id=$1 AND id=$2',
            [a.principal.userId, fault],
          );
          if (found.rowCount) throw new Error('test-only-report-fault');
        });
        return operation(tx);
      });
    try {
      await assert.rejects(r.generate(a.principal, fault, daily(accountId)));
    } finally {
      db.transaction = original;
    }
    const after = await r.generate(a.principal, fault, daily(accountId));
    assert.equal(after.generation, results[0]!.generation + 1);
    assert.equal(
      (
        await h.request(
          'reports/chronicles/' + fault,
          'DELETE',
          undefined,
          a.accessToken,
        )
      ).status,
      204,
    );
    await assert.rejects(r.generate(a.principal, fault, daily(accountId)));
    // An old server observation creates an already-expired artifact without bypassing production triggers.
    const fake = r as unknown as { now: (tx: Transaction) => Promise<string> };
    const now = fake.now;
    fake.now = async () => new Date(Date.now() - 8 * 86400000).toISOString();
    // Use a fresh owner so the monotonic server-clock protection remains intact.
    const b = await h.login('report-expired'),
      ba = (
        await f.createAccount(b.principal, randomUUID(), {
          name: 'old',
          type: 'cash',
          currency: 'BRL',
          openingMinor: '0',
          openedAt: '2026-01-01T00:00:00.000Z',
          source: 'user-confirmed',
        })
      ).accountId!;
    const expired = randomUUID();
    try {
      await assert.rejects(r.generate(b.principal, expired, daily(ba)));
    } finally {
      fake.now = now;
    }
    await assert.rejects(r.get(b.principal, expired));
    const retainedBefore = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        b.principal.userId,
      ]);
      return (
        await tx.query('SELECT count(*)::int AS n FROM app.report_snapshots')
      ).rows[0];
    });
    assert.deepEqual(retainedBefore, { n: 1 });
    await r.sweepExpired();
    const n = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        b.principal.userId,
      ]);
      return (
        await tx.query('SELECT count(*)::int AS n FROM app.report_snapshots')
      ).rows[0];
    });
    assert.deepEqual(n, { n: 0 });
    await assert.rejects(r.generate(b.principal, expired, daily(ba)));
  } finally {
    await h.close();
  }
});

test('real bounded report selection rejects 1001 tail buckets before decryption without truncated artifact', async () => {
  const h = await harness();
  try {
    const a = await h.login('report-bounds'),
      f = h.module.get(FinanceService),
      r = h.module.get(ReportingService),
      accountId = (
        await f.createAccount(a.principal, randomUUID(), {
          name: 'bounds',
          type: 'cash',
          currency: 'BRL',
          openingMinor: '0',
          openedAt: '2020-01-01T00:00:00.000Z',
          source: 'user-confirmed',
        })
      ).accountId!;
    // Synthetic bounded-selection inventory is test-only. Ciphertexts are deliberately not opened:
    // the cap must reject the selection before trusting or summing any truncated subset.
    await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a.principal.userId,
      ]);
      await tx.query(
        "INSERT INTO app.finance_buckets SELECT user_id,account_id,currency,to_char(d,'YYYY-MM-DD'),to_char(d,'YYYY-MM'),last_seq,revision,dek_id,dek_version,payload FROM app.finance_buckets CROSS JOIN generate_series('2023-01-01'::date,'2025-09-27'::date,'1 day'::interval) d WHERE user_id=$1 AND account_id=$2",
        [a.principal.userId, accountId],
      );
    });
    const key = randomUUID();
    await assert.rejects(
      r.generate(a.principal, key, {
        accountId,
        type: 'CUSTOM',
        from: '2023-01-01',
        through: '2023-12-31',
      }),
      (e: unknown) =>
        e instanceof Error && 'code' in e && e.code === 'bounded_period',
    );
    const response = await h.request(
      'reports/custom',
      'POST',
      {
        idempotencyKey: key,
        accountId,
        from: '2023-01-01',
        through: '2023-12-31',
      },
      a.accessToken,
    );
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      code: 'BOUNDED_PERIOD_REQUIRED',
    });
    const n = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a.principal.userId,
      ]);
      return (
        await tx.query('SELECT count(*)::int AS n FROM app.report_requests')
      ).rows[0];
    });
    assert.deepEqual(n, { n: 0 });
  } finally {
    await h.close();
  }
});
