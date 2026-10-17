import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness } from '../fixtures/identity-harness';
import { GameService } from '../../src/game/game.service';
import { GoalsService } from '../../src/planning/goals/goals.service';
import { FinanceService } from '../../src/finance/finance.service';
import { WorkService } from '../../src/work/work.service';
import { Transaction } from '../../src/platform/database';
type H = Awaited<ReturnType<typeof harness>>;
type User = Awaited<ReturnType<H['login']>>;
async function goal(h: H, a: User) {
  const f = h.module.get(FinanceService);
  const account = (
    await f.createAccount(a.principal, randomUUID(), {
      name: 'GAME_ACCOUNT_CANARY',
      type: 'savings',
      currency: 'BRL',
      openingMinor: '0',
      openedAt: '2026-01-01T00:00:00.000Z',
      source: 'user-confirmed',
    })
  ).accountId!;
  const g = await h.module.get(GoalsService).create(a.principal, randomUUID(), {
    title: 'GAME_PRIVATE_GOAL_CANARY',
    description: null,
    targetMinor: '987654321',
    currency: 'BRL',
    startDate: '2026-01-01',
    deadline: '2027-12-31',
    fundingAccountId: account,
    retainedEarningsBasisPoints: 10000,
  });
  return { account, g };
}
const work = {
  workStatus: 'unemployed',
  occupation: null,
  workModel: 'none',
  earningModel: 'VARIABLE',
  currency: 'BRL',
  components: [{ kind: 'VARIABLE', amountMinor: null }],
  availability: {
    availableMinutesPerDay: 0,
    preferredWeekdays: [],
    maximumMinutesPerWeek: 0,
    committedMinutesPerWeek: null,
  },
  skills: [],
  desiredDirection: null,
  careerTarget: null,
  notes: null,
};
async function owner<T>(h: H, a: User, fn: (tx: Transaction) => Promise<T>) {
  return h.db.transaction(async (tx) => {
    await tx.query("SELECT set_config('forja.user_id',$1,true)", [
      a.principal.userId,
    ]);
    return fn(tx);
  });
}
async function json<T>(r: Response) {
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  return (await r.json()) as T;
}
test('real deterministic goal/reserve assignment, expected money exclusion, concurrent completion, no financial effects, correction history and encrypted XP', async () => {
  const h = await harness();
  try {
    const a = await h.login('game-goal'),
      b = await h.login('game-foreign'),
      game = h.module.get(GameService),
      f = h.module.get(FinanceService),
      { account, g } = await goal(h, a),
      key = randomUUID();
    const assigned = await Promise.all(
      Array.from({ length: 8 }, () =>
        game.assign(a.principal, key, 'RESERVE_TARGET', g.id, 1),
      ),
    );
    assert.equal(new Set(assigned.map((m) => m.id)).size, 1);
    const m = assigned[0]!;
    await assert.rejects(game.assign(a.principal, key, 'GOAL_TARGET', g.id, 1));
    assert.equal(
      (
        await h.request(
          `game/missions/${m.id}`,
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
          `game/missions/${m.id}/evaluate`,
          'POST',
          {},
          b.accessToken,
        )
      ).status,
      404,
    );
    const unauthorizedAward = await h.request(
      'game/missions',
      'POST',
      {
        idempotencyKey: randomUUID(),
        template: 'GOAL_TARGET',
        goalId: g.id,
        goalRevision: 1,
        xp: 999,
      },
      a.accessToken,
    );
    assert.equal(unauthorizedAward.status, 400);
    assert.equal(
      (
        await h.request(
          `game/missions/${m.id}/claim`,
          'POST',
          {},
          a.accessToken,
        )
      ).status,
      404,
    );
    await json(
      await h.request(
        'planning/expected',
        'POST',
        {
          idempotencyKey: randomUUID(),
          accountId: account,
          currency: 'BRL',
          dueAt: '2027-01-01T00:00:00.000Z',
          kind: 'predicted-income',
          amountMinor: '987654321',
          note: 'GAME_PREDICTED_CANARY',
          source: 'user-confirmed',
        },
        a.accessToken,
      ),
    );
    assert.equal((await game.evaluate(a.principal, m.id)).state, 'ACTIVE');
    assert.equal((await game.summary(a.principal)).xp, 0);
    const income = await f.posting(a.principal, randomUUID(), 'income', {
      accountId: account,
      amountMinor: '987654321',
      effectiveAt: new Date().toISOString(),
      note: 'GAME_RECEIVED_CANARY',
    });
    const balance = await f.accounts(a.principal, undefined, 100);
    const completed = await Promise.all(
      Array.from({ length: 8 }, () => game.evaluate(a.principal, m.id)),
    );
    assert.ok(
      completed.every(
        (v) => v.state === 'COMPLETED' && v.rewardState === 'AWARDED',
      ),
    );
    assert.equal((await game.summary(a.principal)).xp, 50);
    assert.deepEqual(await f.accounts(a.principal, undefined, 100), balance);
    const rewardCount = await owner(
      h,
      a,
      async (tx) =>
        (await tx.query('SELECT count(*)::int AS n FROM app.game_awards'))
          .rows[0],
    );
    assert.deepEqual(rewardCount, { n: 1 });
    await f.adjust(a.principal, randomUUID(), income.eventIds[0]!);
    const corrected = await game.evaluate(a.principal, m.id);
    assert.equal(corrected.state, 'COMPLETED');
    assert.equal(corrected.reconciliation, 'CHANGED');
    assert.equal((await game.summary(a.principal)).xp, 50);
    assert.equal(
      (await game.assign(a.principal, randomUUID(), 'RESERVE_TARGET', g.id, 1))
        .id,
      m.id,
    );
    const dump = await owner(h, a, async (tx) =>
      JSON.stringify(
        (
          await tx.query(
            'SELECT row_to_json(h) AS data FROM app.game_mission_history h UNION ALL SELECT row_to_json(a) AS data FROM app.game_awards a',
          )
        ).rows,
      ),
    );
    for (const sensitive of [
      '987654321',
      'targetMinor',
      'creditedMinor',
      'totalXp',
      'RESERVE_TARGET',
      'GAME_PRIVATE_GOAL_CANARY',
    ])
      assert.equal(dump.includes(sensitive), false);
    assert.ok(
      !h.lines.some((l) => l.includes('CANARY') || l.includes('987654321')),
    );
    const rows = await owner(h, b, (tx) =>
      tx.query('SELECT id FROM app.game_missions WHERE user_id=$1', [
        a.principal.userId,
      ]),
    );
    assert.equal(rows.rowCount, 0);
    await assert.rejects(
      owner(h, a, (tx) =>
        tx.query(
          'UPDATE app.game_awards SET payload=payload WHERE user_id=$1',
          [a.principal.userId],
        ),
      ),
    );
    await h.identity.deletion(a.principal);
    const inventory = await h.owner.query(
      'SELECT (SELECT count(*)::int FROM app.game_missions WHERE user_id=$1) AS missions,(SELECT count(*)::int FROM app.game_mission_history WHERE user_id=$1) AS history,(SELECT count(*)::int FROM app.game_awards WHERE user_id=$1) AS awards,(SELECT count(*)::int FROM app.game_progression WHERE user_id=$1) AS progression',
      [a.principal.userId],
    );
    assert.deepEqual(inventory.rows[0], {
      missions: 0,
      history: 0,
      awards: 0,
      progression: 0,
    });
  } finally {
    await h.close();
  }
});
test('real Work mission without Finance stream, zero availability qualifies and source earns only once', async () => {
  const h = await harness();
  try {
    const a = await h.login('game-work'),
      game = h.module.get(GameService),
      w = h.module.get(WorkService);
    assert.equal((await game.summary(a.principal)).level, 1);
    const m = await game.assign(
      a.principal,
      randomUUID(),
      'WORK_PROFILE',
      null,
      null,
    );
    assert.equal((await game.evaluate(a.principal, m.id)).state, 'ACTIVE');
    await w.replace(a.principal, 0, work);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.request(`game/missions/${m.id}/evaluate`, 'POST', {}, a.accessToken),
      ),
    );
    for (const r of responses) assert.equal(r.status, 200);
    assert.equal((await game.summary(a.principal)).xp, 20);
    assert.equal(
      (await game.assign(a.principal, randomUUID(), 'WORK_PROFILE', null, null))
        .id,
      m.id,
    );
    const c = await h.request(
      'game/missions?view=history',
      'GET',
      undefined,
      a.accessToken,
    );
    const history = await json<{ missions: unknown[] }>(c);
    assert.equal(history.missions.length, 1);
  } finally {
    await h.close();
  }
});
test('real ineligible/expiry/cancellation/revised-goal rules deny completion and duplicate rewards', async (context) => {
  const h = await harness();
  try {
    const a = await h.login('game-expiry'),
      game = h.module.get(GameService),
      f = h.module.get(FinanceService),
      goals = h.module.get(GoalsService),
      { account, g } = await goal(h, a);
    const m = await game.assign(
      a.principal,
      randomUUID(),
      'GOAL_TARGET',
      g.id,
      1,
    );
    await f.posting(a.principal, randomUUID(), 'income', {
      accountId: account,
      amountMinor: '987654321',
      effectiveAt: new Date().toISOString(),
      note: 'GAME_EXPIRED_CANARY',
    });
    const rewind = context.mock.method(
      game as unknown as { now: (tx: Transaction) => Promise<string> },
      'now',
      async () => new Date(Date.parse(m.assignedAt) - 1).toISOString(),
    );
    await assert.rejects(game.evaluate(a.principal, m.id));
    rewind.mock.restore();
    assert.equal((await game.get(a.principal, m.id)).state, 'ACTIVE');
    const clock = context.mock.method(
      game as unknown as { now: (tx: Transaction) => Promise<string> },
      'now',
      async () => m.expiresAt,
    );
    assert.equal((await game.evaluate(a.principal, m.id)).state, 'EXPIRED');
    clock.mock.restore();
    assert.equal((await game.summary(a.principal)).xp, 0);
    const { account: other, g: otherGoal } = await goal(h, a);
    const changed = await game.assign(
      a.principal,
      randomUUID(),
      'GOAL_TARGET',
      otherGoal.id,
      1,
    );
    await goals.revise(a.principal, otherGoal.id, randomUUID(), 1, {
      ...otherGoal.goal,
      targetMinor: '999999999',
    });
    assert.equal(
      (await game.evaluate(a.principal, changed.id)).state,
      'CANCELLED',
    );
    await f.posting(a.principal, randomUUID(), 'income', {
      accountId: other,
      amountMinor: '999999999',
      effectiveAt: new Date().toISOString(),
      note: 'GAME_INELIGIBLE_CANARY',
    });
    await assert.rejects(
      game.assign(a.principal, randomUUID(), 'RESERVE_TARGET', otherGoal.id, 2),
    );
    assert.equal((await game.summary(a.principal)).xp, 0);
  } finally {
    context.mock.restoreAll();
    await h.close();
  }
});
test('real simultaneous different-source awards preserve one owner total and pointer/AAD metadata cannot be replayed', async () => {
  const h = await harness();
  try {
    const a = await h.login('game-sequence'),
      game = h.module.get(GameService),
      f = h.module.get(FinanceService),
      w = h.module.get(WorkService),
      { account, g } = await goal(h, a);
    const reserve = await game.assign(
      a.principal,
      randomUUID(),
      'RESERVE_TARGET',
      g.id,
      1,
    );
    const career = await game.assign(
      a.principal,
      randomUUID(),
      'WORK_PROFILE',
      null,
      null,
    );
    await w.replace(a.principal, 0, work);
    await f.posting(a.principal, randomUUID(), 'income', {
      accountId: account,
      amountMinor: '987654321',
      effectiveAt: new Date().toISOString(),
      note: 'GAME_SIMULTANEOUS_CANARY',
    });
    await Promise.all([
      game.evaluate(a.principal, reserve.id),
      game.evaluate(a.principal, career.id),
    ]);
    const summary = await game.summary(a.principal);
    assert.equal(summary.xp, 70);
    assert.equal(summary.recentEvent?.sequence, 2);
    const original = await game.get(a.principal, reserve.id);
    await owner(h, a, (tx) =>
      tx.query(
        'UPDATE app.game_missions SET revision=1 WHERE user_id=$1 AND id=$2',
        [a.principal.userId, reserve.id],
      ),
    );
    await assert.rejects(game.get(a.principal, reserve.id));
    await owner(h, a, (tx) =>
      tx.query(
        'UPDATE app.game_missions SET revision=$3 WHERE user_id=$1 AND id=$2',
        [a.principal.userId, reserve.id, original.revision],
      ),
    );
    assert.equal((await game.summary(a.principal)).xp, 70);
    const { account: funded, g: fundedGoal } = await goal(h, a);
    await f.posting(a.principal, randomUUID(), 'income', {
      accountId: funded,
      amountMinor: '987654321',
      effectiveAt: new Date().toISOString(),
      note: 'GAME_ALREADY_FUNDED_CANARY',
    });
    await assert.rejects(
      game.assign(a.principal, randomUUID(), 'GOAL_TARGET', fundedGoal.id, 1),
    );
  } finally {
    await h.close();
  }
});
test('real completion transaction failure rolls back mission history and award together', async (context) => {
  const h = await harness();
  try {
    const a = await h.login('game-atomic'),
      game = h.module.get(GameService),
      f = h.module.get(FinanceService),
      { account, g } = await goal(h, a);
    const m = await game.assign(
      a.principal,
      randomUUID(),
      'GOAL_TARGET',
      g.id,
      1,
    );
    await f.posting(a.principal, randomUUID(), 'income', {
      accountId: account,
      amountMinor: '987654321',
      effectiveAt: new Date().toISOString(),
      note: 'GAME_ATOMIC_CANARY',
    });
    const original = h.db.transaction.bind(h.db);
    context.mock.method(
      h.db,
      'transaction',
      async <T>(fn: (tx: Transaction) => Promise<T>) =>
        original(async (tx) => {
          tx.beforeCommit(async () => {
            const award = await tx.query(
              'SELECT mission_id FROM app.game_awards WHERE user_id=$1 AND mission_id=$2',
              [a.principal.userId, m.id],
            );
            if (award.rowCount)
              throw new Error(
                'test-only interrupted commit after award insert',
              );
          });
          return fn(tx);
        }),
    );
    await assert.rejects(game.evaluate(a.principal, m.id));
    context.mock.restoreAll();
    assert.equal((await game.get(a.principal, m.id)).state, 'ACTIVE');
    assert.equal((await game.summary(a.principal)).xp, 0);
    assert.equal((await game.evaluate(a.principal, m.id)).state, 'COMPLETED');
    assert.equal((await game.summary(a.principal)).xp, 50);
  } finally {
    context.mock.restoreAll();
    await h.close();
  }
});
