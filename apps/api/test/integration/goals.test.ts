import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { harness } from '../fixtures/identity-harness';
import { GoalsService } from '../../src/planning/goals/goals.service';
import { FinanceService } from '../../src/finance/finance.service';
import { WorkService } from '../../src/work/work.service';
import { Transaction } from '../../src/platform/database';
import { localDate } from '../../src/planning/goals/model';
import { loadConfig } from '../../src/config/config';
type H = Awaited<ReturnType<typeof harness>>;
type User = Awaited<ReturnType<H['login']>>;
type G = Awaited<ReturnType<GoalsService['create']>>;
type C = Awaited<ReturnType<GoalsService['generate']>>;
async function json<T>(r: Response, status = 200): Promise<T> {
  assert.equal(r.status, status);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  return (await r.json()) as T;
}
function day(offset = 0) {
  return new Date(
    Date.parse(localDate(new Date().toISOString(), 'UTC')) + offset * 86400000,
  )
    .toISOString()
    .slice(0, 10);
}
function config(accountId: string) {
  return {
    title: 'S3_GOAL_TITLE_CANARY_05B',
    description: 'S3_GOAL_DESCRIPTION_CANARY_05B',
    targetMinor: '1000000',
    currency: 'BRL',
    startDate: day(),
    deadline: day(30),
    fundingAccountId: accountId,
    retainedEarningsBasisPoints: 10000,
  };
}
const work = {
  workStatus: 'self-employed',
  occupation: 'S3_OCCUPATION_CANARY_05B',
  workModel: 'independent',
  earningModel: 'HOURLY',
  currency: 'BRL',
  components: [{ kind: 'HOURLY', amountMinor: '10000' }],
  availability: {
    availableMinutesPerDay: 240,
    preferredWeekdays: [1, 2, 3, 4, 5],
    maximumMinutesPerWeek: 2400,
    committedMinutesPerWeek: null,
  },
  skills: ['PRIVATE_SKILL_CANARY_05B'],
  desiredDirection: null,
  careerTarget: null,
  notes: null,
};
async function account(
  h: H,
  a: User,
  currency: 'BRL' | 'USD' = 'BRL',
  openingMinor = '200000',
) {
  return (
    await h.module
      .get(FinanceService)
      .createAccount(a.principal, randomUUID(), {
        name: 'GOAL_ACCOUNT_CANARY_05B',
        type: 'savings',
        currency,
        openingMinor,
        openedAt: '2026-01-01T00:00:00.000Z',
        source: 'user-confirmed',
      })
  ).accountId!;
}
async function expected(
  h: H,
  a: User,
  accountId: string,
  kind: string,
  amountMinor: string,
  dueAt = day(1) + 'T12:00:00.000Z',
) {
  return json<{ expectedId: string }>(
    await h.request(
      'planning/expected',
      'POST',
      {
        idempotencyKey: randomUUID(),
        accountId,
        currency: 'BRL',
        dueAt,
        kind,
        amountMinor,
        note: 'EXPECTED_GOAL_CANARY_05B',
        source: 'user-confirmed',
      },
      a.accessToken,
    ),
  );
}
async function generate(h: H, a: User, g: G, key = randomUUID()) {
  return json<C>(
    await h.request(
      `planning/goals/${g.id}/calculations`,
      'POST',
      {
        idempotencyKey: key,
        expectedRevision: g.revision,
        workRevision: null,
        projectCount: null,
      },
      a.accessToken,
    ),
  );
}
async function owner<T>(h: H, a: User, fn: (tx: Transaction) => Promise<T>) {
  return h.db.transaction(async (tx) => {
    await tx.query("SELECT set_config('forja.user_id',$1,true)", [
      a.principal.userId,
    ]);
    return fn(tx);
  });
}
test('real goals, exact deficits, separate scenarios, immutable goal/Work/Finance/Identity calculation provenance', async () => {
  const h = await harness();
  try {
    const a = await h.login('goals-provenance'),
      f = h.module.get(FinanceService),
      w = h.module.get(WorkService),
      goals = h.module.get(GoalsService),
      accountId = await account(h, a);
    await w.replace(a.principal, 0, work);
    const baseline = await f.accounts(a.principal, undefined, 100);
    const created = await json<G>(
      await h.request(
        'planning/goals',
        'POST',
        { idempotencyKey: randomUUID(), goal: config(accountId) },
        a.accessToken,
      ),
    );
    assert.equal(created.status, 'ACTIVE');
    const progress = await json<{
      creditedMinor: string;
      remainingMinor: string;
    }>(
      await h.request(
        `planning/goals/${created.id}/progress`,
        'GET',
        undefined,
        a.accessToken,
      ),
    );
    assert.equal(progress.creditedMinor, '200000');
    assert.equal(progress.remainingMinor, '800000');
    const receivable = await expected(h, a, accountId, 'receivable', '300000');
    await expected(h, a, accountId, 'predicted-income', '50000');
    await expected(h, a, accountId, 'scheduled-debit', '100000');
    await expected(h, a, accountId, 'payable', '50000');
    await expected(
      h,
      a,
      accountId,
      'receivable',
      '900000',
      day(40) + 'T12:00:00.000Z',
    );
    const first = await generate(h, a, created);
    assert.equal(first.conservative.remainingMinor, '800000');
    assert.equal(first.planned.remainingMinor, '600000');
    assert.equal(first.planned.receivableMinor, '300000');
    assert.equal(first.planned.predictedIncomeMinor, '50000');
    assert.equal(first.planned.scheduledDebitMinor, '100000');
    assert.equal(first.expectedInputs.length, 4);
    assert.equal(first.financeCursor, baseline.cursor);
    assert.equal(first.conservative.rates.hourMinor !== null, true);
    assert.equal(first.workRevision, 1);
    assert.equal(first.planned.capacityComparison, 'UNKNOWN');
    assert.deepEqual(await f.accounts(a.principal, undefined, 100), baseline);
    const largeExpense = await expected(
      h,
      a,
      accountId,
      'scheduled-debit',
      '2000000',
    );
    const shortfall = await generate(h, a, created);
    assert.equal(shortfall.planned.projectedBalanceMinor, '-1600000');
    assert.equal(shortfall.planned.remainingMinor, '1000000');
    assert.equal(shortfall.planned.fundingShortfallMinor, '1600000');
    assert.equal(shortfall.planned.requiredGrossMinor, '2600000');
    await json(
      await h.request(
        `planning/expected/${largeExpense.expectedId}/cancel`,
        'POST',
        { idempotencyKey: randomUUID() },
        a.accessToken,
      ),
    );
    const conditionalReceipt = await expected(
      h,
      a,
      accountId,
      'receivable',
      '1000000',
    );
    const conditional = await generate(h, a, created);
    assert.equal(conditional.planned.remainingMinor, '0');
    assert.equal((await goals.get(a.principal, created.id)).status, 'ACTIVE');
    assert.equal(
      (
        await h.request(
          `planning/goals/${created.id}/state`,
          'POST',
          {
            idempotencyKey: randomUUID(),
            expectedRevision: 1,
            action: 'complete',
          },
          a.accessToken,
        )
      ).status,
      409,
    );
    await json(
      await h.request(
        `planning/expected/${conditionalReceipt.expectedId}/cancel`,
        'POST',
        { idempotencyKey: randomUUID() },
        a.accessToken,
      ),
    );
    await w.replace(a.principal, 1, {
      ...work,
      availability: { ...work.availability, availableMinutesPerDay: 120 },
    });
    const second = await generate(h, a, created);
    assert.equal(second.workRevision, 2);
    assert.equal(
      BigInt(second.conservative.rates.hourMinor!) >=
        2n * BigInt(first.conservative.rates.hourMinor!) - 1n,
      true,
    );
    assert.deepEqual(
      await goals.getCalculation(a.principal, created.id, first.calculationId),
      first,
    );
    await f.posting(a.principal, randomUUID(), 'income', {
      accountId,
      amountMinor: '100000',
      effectiveAt: new Date().toISOString(),
      note: 'ACTUAL_GOAL_CANARY_05B',
    });
    const third = await generate(h, a, created);
    assert.ok(third.financeCursor > first.financeCursor);
    assert.ok(third.accountRevision > first.accountRevision);
    assert.equal(third.conservative.remainingMinor, '700000');
    assert.equal(third.planned.remainingMinor, '500000');
    const revised = await json<G>(
      await h.request(
        `planning/goals/${created.id}`,
        'PUT',
        {
          idempotencyKey: randomUUID(),
          expectedRevision: 1,
          goal: { ...config(accountId), targetMinor: '1200000' },
        },
        a.accessToken,
      ),
    );
    assert.equal(revised.revision, 2);
    assert.deepEqual(await goals.get(a.principal, created.id, 1), created);
    assert.deepEqual(
      await goals.getCalculation(a.principal, created.id, first.calculationId),
      first,
    );
    const fourth = await generate(h, a, revised);
    assert.equal(fourth.goalRevision, 2);
    assert.equal(fourth.conservative.remainingMinor, '900000');
    await json(
      await h.request(
        `planning/expected/${receivable.expectedId}/cancel`,
        'POST',
        { idempotencyKey: randomUUID() },
        a.accessToken,
      ),
    );
    const afterCancel = await generate(h, a, revised);
    assert.equal(afterCancel.expectedInputs.length, 3);
    assert.equal(afterCancel.planned.receivableMinor, '0');
    assert.deepEqual(
      await goals.getCalculation(a.principal, created.id, first.calculationId),
      first,
    );
    const identity = await h.identity.profile(a.principal);
    await h.identity.update(a.principal, identity.revision, {
      displayName: null,
      locale: identity.locale,
      timezone: 'America/New_York',
      preferredCurrency: identity.preferredCurrency,
      onboardingState: identity.onboardingState,
    });
    const changedTimezone = await generate(h, a, revised);
    assert.equal(changedTimezone.timezone, 'America/New_York');
    assert.ok(
      changedTimezone.identityProfileRevision > first.identityProfileRevision,
    );
    assert.deepEqual(
      await goals.getCalculation(a.principal, created.id, first.calculationId),
      first,
    );
    const facts = await goals.advisoryFacts(
      a.principal,
      created.id,
      first.calculationId,
    );
    assert.equal(JSON.stringify(facts).includes('CANARY_05B'), false);
    assert.equal('userId' in facts, false);
    assert.equal('timezone' in facts, false);
    const list = await json<{ goals: G[] }>(
      await h.request(
        'planning/goals?limit=1',
        'GET',
        undefined,
        a.accessToken,
      ),
    );
    assert.equal(list.goals.length, 1);
    assert.equal(
      h.lines.some((line) => line.includes('CANARY_05B')),
      false,
    );
  } finally {
    await h.close();
  }
});
test('real idempotency/CAS, exclusive funding, lifecycle and concurrent Finance capture', async () => {
  const h = await harness();
  try {
    const a = await h.login('goals-concurrency'),
      goals = h.module.get(GoalsService),
      f = h.module.get(FinanceService),
      accountId = await account(h, a);
    const key = randomUUID(),
      input = config(accountId);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.request(
          'planning/goals',
          'POST',
          { idempotencyKey: key, goal: input },
          a.accessToken,
        ),
      ),
    );
    const values = await Promise.all(responses.map((r) => json<G>(r)));
    assert.equal(new Set(values.map((v) => v.id)).size, 1);
    const created = values[0]!;
    assert.equal(
      (
        await h.request(
          'planning/goals',
          'POST',
          { idempotencyKey: key, goal: { ...input, targetMinor: '2000000' } },
          a.accessToken,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await h.request(
          'planning/goals',
          'POST',
          { idempotencyKey: randomUUID(), goal: input },
          a.accessToken,
        )
      ).status,
      409,
    );
    const edits = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.request(
          `planning/goals/${created.id}`,
          'PUT',
          {
            idempotencyKey: randomUUID(),
            expectedRevision: 1,
            goal: { ...input, description: 'REVISED_GOAL_CANARY_05B' },
          },
          a.accessToken,
        ),
      ),
    );
    assert.equal(edits.filter((r) => r.status === 200).length, 1);
    assert.equal(edits.filter((r) => r.status === 409).length, 7);
    let g = await goals.get(a.principal, created.id);
    assert.equal(
      (
        await h.request(
          `planning/goals/${g.id}/state`,
          'POST',
          {
            idempotencyKey: randomUUID(),
            expectedRevision: g.revision,
            action: 'complete',
          },
          a.accessToken,
        )
      ).status,
      409,
    );
    g = await goals.transition(
      a.principal,
      g.id,
      randomUUID(),
      g.revision,
      'pause',
    );
    assert.equal((await generate(h, a, g)).conservative.rates.hourMinor, null);
    g = await goals.transition(
      a.principal,
      g.id,
      randomUUID(),
      g.revision,
      'resume',
    );
    const before = await f.accounts(a.principal, undefined, 100),
      calcKey = randomUUID();
    const [calc, posted] = await Promise.all([
      generate(h, a, g, calcKey),
      f.posting(a.principal, randomUUID(), 'income', {
        accountId,
        amountMinor: '800000',
        effectiveAt: new Date().toISOString(),
        note: 'CONCURRENT_GOAL_CANARY_05B',
      }),
    ]);
    assert.ok([before.cursor, posted.seq].includes(calc.financeCursor));
    assert.equal(
      calc.conservative.creditedMinor,
      calc.financeCursor === before.cursor ? '200000' : '1000000',
    );
    assert.deepEqual(await generate(h, a, g, calcKey), calc);
    g = await goals.transition(
      a.principal,
      g.id,
      randomUUID(),
      g.revision,
      'complete',
    );
    assert.equal(g.status, 'COMPLETED');
    assert.equal(g.completion?.creditedMinor, '1000000');
    await f.posting(a.principal, randomUUID(), 'expense', {
      accountId,
      amountMinor: '100000',
      effectiveAt: new Date().toISOString(),
      note: 'AFTER_COMPLETE_CANARY_05B',
    });
    assert.equal(
      (await goals.progress(a.principal, g.id)).remainingMinor,
      '100000',
    );
    assert.equal((await goals.get(a.principal, g.id)).status, 'COMPLETED');
    g = await goals.transition(
      a.principal,
      g.id,
      randomUUID(),
      g.revision,
      'resume',
    );
    const cancelKey = randomUUID();
    g = await goals.transition(
      a.principal,
      g.id,
      cancelKey,
      g.revision,
      'cancel',
    );
    assert.equal((await goals.progress(a.principal, g.id)).creditedMinor, '0');
    assert.equal(g.status, 'CANCELLED');
    const replacement = await goals.create(a.principal, randomUUID(), input);
    assert.notEqual(replacement.id, g.id);
    assert.equal(
      (await goals.progress(a.principal, replacement.id)).creditedMinor,
      '900000',
    );
    assert.deepEqual(await goals.create(a.principal, key, input), created);
  } finally {
    await h.close();
  }
});
test('real missing/zero Work, monthly capacity, today/expired/multi-year goals and funding currency denial', async () => {
  const h = await harness();
  try {
    const a = await h.login('goals-time'),
      b = await h.login('goals-foreign'),
      goals = h.module.get(GoalsService),
      w = h.module.get(WorkService),
      accountId = await account(h, a);
    let g = await goals.create(a.principal, randomUUID(), {
      ...config(accountId),
      deadline: day(),
    });
    let c = await generate(h, a, g);
    assert.equal(c.days, 1);
    assert.equal(c.workRevision, null);
    assert.equal(c.conservative.rates.hourMinor, null);
    assert.equal(c.conservative.rates.calendarDayMinor, '800000');
    await w.replace(a.principal, 0, {
      ...work,
      availability: {
        availableMinutesPerDay: 0,
        preferredWeekdays: [],
        maximumMinutesPerWeek: 0,
        committedMinutesPerWeek: 0,
      },
    });
    c = await generate(h, a, g);
    assert.equal(c.minutes, 0);
    assert.equal(c.conservative.rates.hourMinor, null);
    assert.equal(c.conservative.rates.workdayMinor, null);
    await w.replace(a.principal, 1, {
      ...work,
      earningModel: 'FIXED_MONTHLY',
      components: [{ kind: 'FIXED_MONTHLY', amountMinor: '10000000' }],
    });
    c = await generate(h, a, g);
    assert.equal(c.declaredMonthlyMinor, '10000000');
    assert.equal(c.conservative.capacityComparison, 'ABOVE_DECLARED_CAPACITY');
    g = await goals.revise(a.principal, g.id, randomUUID(), g.revision, {
      ...config(accountId),
      deadline: day(30),
    });
    c = await generate(h, a, g);
    assert.equal(c.conservative.capacityComparison, 'WITHIN_DECLARED_CAPACITY');
    assert.ok(
      BigInt(c.conservative.rates.monthMinor!) <=
        BigInt(c.declaredMonthlyMinor!),
    );
    g = await goals.revise(a.principal, g.id, randomUUID(), g.revision, {
      ...config(accountId),
      startDate: day(-10),
      deadline: day(-1),
    });
    c = await generate(h, a, g);
    assert.equal(c.days, 0);
    assert.equal(c.conservative.rateReason, 'expired');
    assert.equal(c.conservative.remainingMinor, '800000');
    g = await goals.revise(a.principal, g.id, randomUUID(), g.revision, {
      ...config(accountId),
      deadline: day(800),
    });
    c = await generate(h, a, g);
    assert.equal(c.days, 801);
    assert.equal(c.conservative.capacityComparison, 'UNKNOWN');
    assert.equal(c.conservative.comparisonReason, 'work-horizon-bound');
    assert.ok(c.conservative.rates.monthMinor);
    const usd = await account(h, a, 'USD');
    assert.equal(
      (
        await h.request(
          'planning/goals',
          'POST',
          { idempotencyKey: randomUUID(), goal: config(usd) },
          a.accessToken,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await h.request(
          'planning/goals',
          'POST',
          { idempotencyKey: randomUUID(), goal: config(accountId) },
          b.accessToken,
        )
      ).status,
      404,
    );
    for (const path of [
      `planning/goals/${g.id}`,
      `planning/goals/${g.id}/progress`,
      `planning/goals/${g.id}/required-income`,
      `planning/goals/${g.id}/calculations/${c.calculationId}`,
    ])
      assert.equal(
        (await h.request(path, 'GET', undefined, b.accessToken)).status,
        404,
      );
    assert.equal(
      (
        await h.request(
          `planning/goals/${g.id}`,
          'PUT',
          {
            idempotencyKey: randomUUID(),
            expectedRevision: g.revision,
            goal: config(accountId),
          },
          b.accessToken,
        )
      ).status,
      404,
    );
    assert.equal((await h.request('planning/goals')).status, 401);
  } finally {
    await h.close();
  }
});
test('real encrypted goal evidence, forced RLS/AAD replay, failed writes, nonce burning and privacy erasure', async (context) => {
  const h = await harness();
  try {
    const a = await h.login('goals-security'),
      b = await h.login('goals-security-other'),
      goals = h.module.get(GoalsService),
      accountId = await account(h, a),
      bAccount = await account(h, b);
    let g = await goals.create(a.principal, randomUUID(), config(accountId));
    await goals.create(b.principal, randomUUID(), config(bAccount));
    const c = await generate(h, a, g);
    const rows = await owner(
      h,
      a,
      async (tx) =>
        (await tx.query('SELECT * FROM app.planning_goal_history')).rows,
    );
    assert.equal(JSON.stringify(rows).includes('CANARY_05B'), false);
    assert.equal(JSON.stringify(rows).includes('targetMinor'), false);
    const noContext = await h.db.query(
      'SELECT * FROM app.planning_goal_calculations',
    );
    assert.equal(noContext.rowCount, 0);
    const foreign = await owner(
      h,
      b,
      async (tx) =>
        (
          await tx.query('SELECT * FROM app.planning_goals WHERE user_id=$1', [
            a.principal.userId,
          ])
        ).rowCount,
    );
    assert.equal(foreign, 0);
    for (const table of [
      'planning_goal_history',
      'planning_goal_calculations',
      'planning_goal_receipts',
    ])
      await assert.rejects(
        owner(h, a, (tx) =>
          tx.query(`DELETE FROM app.${table} WHERE user_id=$1`, [
            a.principal.userId,
          ]),
        ),
      );
    const policies = await h.owner.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('planning_goals','planning_goal_history','planning_goal_calculations','planning_goal_receipts')",
    );
    assert.equal(policies.rows.length, 4);
    assert.equal(
      policies.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity),
      true,
    );
    const cfg = loadConfig().database,
      pass = join(
        process.env['CRYPTO_CONTROL_DIRECTORY']!,
        `goal-pgpass-${randomUUID()}`,
      ),
      escape = (v: string) => v.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
    writeFileSync(
      pass,
      [cfg.host, String(cfg.port), cfg.database, cfg.user, cfg.password]
        .map(escape)
        .join(':') + '\n',
      { mode: 0o600 },
    );
    try {
      const dump = spawnSync(
        '/opt/forja-pg-tools/bin/pg_dump',
        [
          '--host',
          cfg.host,
          '--port',
          String(cfg.port),
          '--username',
          cfg.user,
          '--dbname',
          cfg.database,
          '--data-only',
          '--inserts',
          '--enable-row-security',
          '--table=app.planning_goal*',
        ],
        {
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            LD_LIBRARY_PATH: '/opt/forja-pg-tools/lib',
            PGPASSFILE: pass,
            PGOPTIONS: `-c forja.user_id=${a.principal.userId}`,
          },
        },
      );
      assert.equal(dump.status, 0);
      assert.ok(
        dump.stdout.includes('INSERT INTO app.planning_goal_calculations'),
      );
      for (const value of [
        'CANARY_05B',
        '"targetMinor"',
        '"balanceMinor"',
        '"retainedEarningsBasisPoints"',
        'COMPLETED',
        '"status"',
      ])
        assert.equal(dump.stdout.includes(value), false);
    } finally {
      unlinkSync(pass);
    }
    // Test-only table owner bypasses the immutable trigger and explicitly admits its own owner scope.
    async function attack(sql: string, args: unknown[]) {
      const conn = await h.owner.connect();
      try {
        await conn.query('BEGIN');
        await conn.query(
          'ALTER TABLE app.planning_goal_calculations DISABLE TRIGGER planning_goal_calculations_immutable',
        );
        await conn.query(
          "CREATE POLICY pr05b_attack ON app.planning_goal_calculations TO forja_migrator USING(user_id::text=current_setting('forja.user_id',true)) WITH CHECK(user_id::text=current_setting('forja.user_id',true))",
        );
        await conn.query("SELECT set_config('forja.user_id',$1,true)", [
          a.principal.userId,
        ]);
        assert.equal((await conn.query(sql, args)).rowCount, 1);
        await conn.query(
          'DROP POLICY pr05b_attack ON app.planning_goal_calculations',
        );
        await conn.query(
          'ALTER TABLE app.planning_goal_calculations ENABLE TRIGGER planning_goal_calculations_immutable',
        );
        await conn.query('COMMIT');
      } catch (e) {
        await conn.query('ROLLBACK');
        throw e;
      } finally {
        conn.release();
      }
    }
    const original = await owner(
      h,
      a,
      async (tx) =>
        (
          await tx.query(
            'SELECT * FROM app.planning_goal_calculations WHERE id=$1',
            [c.calculationId],
          )
        ).rows[0]!,
    );
    await attack(
      'UPDATE app.planning_goal_calculations SET finance_cursor=finance_cursor+1 WHERE user_id=$1 AND id=$2',
      [a.principal.userId, c.calculationId],
    );
    assert.equal(
      (
        await h.request(
          `planning/goals/${g.id}/calculations/${c.calculationId}`,
          'GET',
          undefined,
          a.accessToken,
        )
      ).status,
      503,
    );
    await attack(
      'UPDATE app.planning_goal_calculations SET finance_cursor=$3 WHERE user_id=$1 AND id=$2',
      [a.principal.userId, c.calculationId, original['finance_cursor']],
    );
    g = await goals.revise(a.principal, g.id, randomUUID(), g.revision, {
      ...config(accountId),
      targetMinor: '1100000',
    });
    await owner(h, a, (tx) =>
      tx.query(
        'UPDATE app.planning_goals SET revision=1 WHERE user_id=$1 AND id=$2',
        [a.principal.userId, g.id],
      ),
    );
    assert.equal(
      (
        await h.request(
          `planning/goals/${g.id}`,
          'GET',
          undefined,
          a.accessToken,
        )
      ).status,
      503,
    );
    await owner(h, a, (tx) =>
      tx.query(
        'UPDATE app.planning_goals SET revision=2,updated_at=$3 WHERE user_id=$1 AND id=$2',
        [a.principal.userId, g.id, g.recordedAt],
      ),
    );
    const control = new DatabaseSync(
        join(process.env['CRYPTO_CONTROL_DIRECTORY']!, 'lifecycle.sqlite'),
      ),
      counter = () =>
        Number(
          control
            .prepare(
              "SELECT count FROM keys WHERE user_id=? AND state='active'",
            )
            .get(a.principal.userId)?.count,
        ),
      before = counter(),
      transaction = h.db.transaction.bind(h.db);
    context.mock.method(
      h.db,
      'transaction',
      async (fn: (tx: Transaction) => Promise<unknown>) =>
        transaction(async (tx) => {
          tx.beforeCommit(() => {
            throw new Error('COMMIT_GOAL_CANARY_05B');
          });
          return fn(tx);
        }),
    );
    try {
      await assert.rejects(
        goals.revise(a.principal, g.id, randomUUID(), g.revision, {
          ...config(accountId),
          targetMinor: '1200000',
        }),
      );
    } finally {
      context.mock.restoreAll();
    }
    assert.ok(counter() > before);
    control.close();
    assert.equal((await goals.get(a.principal, g.id)).revision, 2);
    assert.deepEqual(
      await goals.getCalculation(a.principal, g.id, c.calculationId),
      c,
    );
    context.mock.method(goals, 'ready', async () => false);
    assert.equal(
      (await fetch((await h.app.getUrl()) + '/health/ready')).status,
      503,
    );
    assert.equal(
      (await fetch((await h.app.getUrl()) + '/health/live')).status,
      200,
    );
    context.mock.restoreAll();
    await h.identity.deletion(a.principal);
    const counts = await owner(
      h,
      a,
      async (tx) =>
        (
          await tx.query(
            'SELECT (SELECT count(*)::int FROM app.planning_goals) AS goals,(SELECT count(*)::int FROM app.planning_goal_history) AS history,(SELECT count(*)::int FROM app.planning_goal_receipts) AS receipts,(SELECT count(*)::int FROM app.planning_goal_calculations) AS calculations',
          )
        ).rows[0],
    );
    assert.deepEqual(counts, {
      goals: 0,
      history: 0,
      receipts: 0,
      calculations: 0,
    });
    assert.equal(
      (
        await h.request(
          `planning/goals/${g.id}`,
          'GET',
          undefined,
          a.accessToken,
        )
      ).status,
      401,
    );
    assert.equal(
      h.lines.some((line) => line.includes('CANARY_05B')),
      false,
    );
  } finally {
    context.mock.restoreAll();
    await h.close();
  }
});
test('real local-deadline expectation filtering, explicit bounded-input rejection and closed funding basis', async () => {
  const h = await harness();
  try {
    const a = await h.login('goals-local-bound'),
      goals = h.module.get(GoalsService),
      f = h.module.get(FinanceService),
      accountId = await account(h, a, 'BRL', '0');
    const profile = await h.identity.profile(a.principal);
    await h.identity.update(a.principal, profile.revision, {
      displayName: null,
      locale: profile.locale,
      timezone: 'America/New_York',
      preferredCurrency: profile.preferredCurrency,
      onboardingState: profile.onboardingState,
    });
    const today = localDate(new Date().toISOString(), 'America/New_York'),
      next = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10),
      g = await goals.create(a.principal, randomUUID(), {
        ...config(accountId),
        startDate: today,
        deadline: today,
      });
    const base = await expected(
      h,
      a,
      accountId,
      'receivable',
      '50000',
      today + 'T23:00:00.000Z',
    );
    await expected(
      h,
      a,
      accountId,
      'predicted-income',
      '60000',
      next + 'T02:00:00.000Z',
    );
    await expected(
      h,
      a,
      accountId,
      'scheduled-debit',
      '70000',
      next + 'T06:00:00.000Z',
    );
    const c = await generate(h, a, g);
    assert.equal(c.expectedInputs.length, 2);
    assert.equal(c.planned.incomingMinor, '110000');
    assert.equal(c.planned.outgoingMinor, '0');
    assert.equal(c.conservative.creditedMinor, '0');
    // Invalid ciphertext clones are confined to tests; the bound rejects before decrypting/truncating them.
    await owner(h, a, (tx) =>
      tx.query(
        'INSERT INTO app.planning_expected SELECT user_id,gen_random_uuid(),account_id,currency,due_at,state,settlement_id,revision,dek_id,dek_version,payload FROM app.planning_expected CROSS JOIN generate_series(1,1000) WHERE user_id=$1 AND id=$2',
        [a.principal.userId, base.expectedId],
      ),
    );
    const rejected = await h.request(
      `planning/goals/${g.id}/calculations`,
      'POST',
      {
        idempotencyKey: randomUUID(),
        expectedRevision: g.revision,
        workRevision: null,
        projectCount: null,
      },
      a.accessToken,
    );
    assert.equal(rejected.status, 422);
    assert.deepEqual(await rejected.json(), {
      code: 'BOUNDED_PERIOD_REQUIRED',
    });
    const calcCount = await owner(
      h,
      a,
      async (tx) =>
        (
          await tx.query(
            'SELECT count(*)::int AS n FROM app.planning_goal_calculations',
          )
        ).rows[0],
    );
    assert.deepEqual(calcCount, { n: 1 });
    await f.closeAccount(a.principal, randomUUID(), accountId);
    assert.equal(
      (await goals.progress(a.principal, g.id)).accountState,
      'closed',
    );
    assert.equal(
      (
        await h.request(
          `planning/goals/${g.id}/calculations`,
          'POST',
          {
            idempotencyKey: randomUUID(),
            expectedRevision: g.revision,
            workRevision: null,
            projectCount: null,
          },
          a.accessToken,
        )
      ).status,
      409,
    );
    assert.deepEqual(
      await goals.getCalculation(a.principal, g.id, c.calculationId),
      c,
    );
  } finally {
    await h.close();
  }
});
