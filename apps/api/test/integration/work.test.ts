import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../../src/config/config';
import { Transaction } from '../../src/platform/database';
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness } from '../fixtures/identity-harness';
import { WorkService } from '../../src/work/work.service';
import { WorkProfile } from '../../src/work/model';
const declared = {
  workStatus: 'self-employed',
  occupation: 'S3_WORK_CANARY_05',
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
  skills: ['S3_SKILL_CANARY_05'],
  desiredDirection: 'S3_DIRECTION_CANARY_05',
  careerTarget: null,
  notes: 'S3_NOTE_CANARY_05',
};
interface Snapshot {
  revision: number;
  recordedAt: string;
  effectiveAt: string;
  profile: WorkProfile;
}
async function json<T>(r: Response, status = 200): Promise<T> {
  assert.equal(r.status, status);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  return (await r.json()) as T;
}
test('real owned professional revisions, deterministic capacity, concurrency, history and unchanged financial truth', async () => {
  const h = await harness();
  try {
    const a = await h.login('work-a'),
      b = await h.login('work-b');
    assert.equal((await h.request('work/profile')).status, 401);
    await json(
      await h.request('work/profile', 'GET', undefined, a.accessToken),
      404,
    );
    const account = await json<{ accountId: string }>(
      await h.request(
        'finance/accounts',
        'POST',
        {
          idempotencyKey: randomUUID(),
          name: 'WORK_ACCOUNT_TEST',
          type: 'cash',
          currency: 'BRL',
          openingMinor: '100000',
          openedAt: '2026-01-01T00:00:00.000Z',
          source: 'user-confirmed',
        },
        a.accessToken,
      ),
    );
    const historyPath = `finance/accounts/${account.accountId}/history`;
    const beforeAccounts = await json(
      await h.request('finance/accounts', 'GET', undefined, a.accessToken),
    );
    const beforeHistory = await json(
      await h.request(historyPath, 'GET', undefined, a.accessToken),
    );
    const first = await json<Snapshot>(
      await h.request(
        'work/profile',
        'PUT',
        { expectedRevision: 0, profile: declared },
        a.accessToken,
      ),
    );
    assert.equal(first.revision, 1);
    assert.equal(first.recordedAt, first.effectiveAt);
    await json(
      await h.request(
        'work/profile',
        'PUT',
        { expectedRevision: 0, profile: declared },
        b.accessToken,
      ),
    );
    const summaryPath = 'work/capacity?from=2026-10-05&through=2026-10-11';
    assert.equal(
      (
        await json<{ totalMinor: string }>(
          await h.request(summaryPath, 'GET', undefined, a.accessToken),
        )
      ).totalMinor,
      '200000',
    );
    const updated = {
      ...declared,
      occupation: 'UPDATED_CANARY_05',
      availability: { ...declared.availability, availableMinutesPerDay: 120 },
    };
    const contenders = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.request(
          'work/profile',
          'PUT',
          { expectedRevision: 1, profile: updated },
          a.accessToken,
        ),
      ),
    );
    assert.equal(contenders.filter((r) => r.status === 200).length, 1);
    assert.equal(contenders.filter((r) => r.status === 409).length, 7);
    assert.equal(
      (
        await json<{ totalMinor: string }>(
          await h.request(summaryPath, 'GET', undefined, a.accessToken),
        )
      ).totalMinor,
      '100000',
    );
    assert.deepEqual(
      await json(
        await h.request(
          'work/profile?revision=1',
          'GET',
          undefined,
          a.accessToken,
        ),
      ),
      first,
    );
    assert.equal(
      (
        await json<{ totalMinor: string }>(
          await h.request(
            summaryPath + '&revision=1',
            'GET',
            undefined,
            a.accessToken,
          ),
        )
      ).totalMinor,
      '200000',
    );
    const fixed = {
      ...declared,
      earningModel: 'FIXED_MONTHLY',
      components: [{ kind: 'FIXED_MONTHLY', amountMinor: '310000' }],
    };
    await json(
      await h.request(
        'work/profile',
        'PUT',
        { expectedRevision: 2, profile: fixed },
        a.accessToken,
      ),
    );
    assert.equal(
      (
        await json<{ totalMinor: string }>(
          await h.request(
            'work/capacity?from=2026-10-01&through=2026-10-31',
            'GET',
            undefined,
            a.accessToken,
          ),
        )
      ).totalMinor,
      '310000',
    );
    assert.deepEqual(
      await json(
        await h.request('finance/accounts', 'GET', undefined, a.accessToken),
      ),
      beforeAccounts,
    );
    assert.deepEqual(
      await json(await h.request(historyPath, 'GET', undefined, a.accessToken)),
      beforeHistory,
    );
    const counts = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a.principal.userId,
      ]);
      return (
        await tx.query(
          'SELECT (SELECT count(*)::int FROM app.finance_events) AS actual, (SELECT count(*)::int FROM app.planning_expected) AS expected',
        )
      ).rows[0];
    });
    assert.deepEqual(counts, { actual: 1, expected: 0 });
    const rows = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a.principal.userId,
      ]);
      return (
        await tx.query(
          'SELECT event,revision FROM app.work_profile_history ORDER BY revision',
        )
      ).rows;
    });
    assert.deepEqual(rows, [
      { event: 'created', revision: 1 },
      { event: 'updated', revision: 2 },
      { event: 'model-changed', revision: 3 },
    ]);
    const context = await h.module.get(WorkService).careerContext(a.principal);
    assert.deepEqual(Object.keys(context).sort(), [
      'desiredDirection',
      'profileRevision',
      'skills',
      'workModel',
      'workStatus',
    ]);
    assert.equal(
      (
        await h.request(
          'work/profile?revision=3',
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
          'work/profile?userId=' + a.principal.userId,
          'GET',
          undefined,
          b.accessToken,
        )
      ).status,
      400,
    );
    for (const invalid of [
      { ...declared, components: [{ kind: 'DAILY', amountMinor: '1' }] },
      { ...declared, notes: undefined },
      { ...declared, components: [{ kind: 'HOURLY', amountMinor: '1.5' }] },
    ])
      assert.equal(
        (
          await h.request(
            'work/profile',
            'PUT',
            { expectedRevision: 3, profile: invalid },
            a.accessToken,
          )
        ).status,
        400,
      );
    assert.equal(
      (
        await h.request(
          summaryPath + '&projectCount=1',
          'GET',
          undefined,
          a.accessToken,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await h.request(
          'work/capacity?from=2026-02-30&through=2026-03-01',
          'GET',
          undefined,
          a.accessToken,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await h.request(
          'work/profile?revision=01',
          'GET',
          undefined,
          a.accessToken,
        )
      ).status,
      400,
    );
    assert.equal(
      h.lines.some((line) => /CANARY_05|10000|310000/.test(line)),
      false,
    );
  } finally {
    await h.close();
  }
});
test('real PostgreSQL ciphertext isolation, forced RLS, immutable audit, AAD replay/tampering and atomic rollback', async () => {
  const h = await harness();
  try {
    const a = await h.login('work-security-a'),
      b = await h.login('work-security-b');
    const work = h.module.get(WorkService);
    await work.replace(a.principal, 0, declared);
    await work.replace(b.principal, 0, declared);
    async function owned<T>(
      user: string,
      fn: (tx: import('../../src/platform/database').Transaction) => Promise<T>,
    ) {
      return h.db.transaction(async (tx) => {
        await tx.query("SELECT set_config('forja.user_id',$1,true)", [user]);
        return fn(tx);
      });
    }
    const arow = await owned(
      a.principal.userId,
      async (tx) =>
        (await tx.query('SELECT * FROM app.work_profile_history')).rows[0]!,
    );
    const brow = await owned(
      b.principal.userId,
      async (tx) =>
        (await tx.query('SELECT * FROM app.work_profile_history')).rows[0]!,
    );
    assert.notEqual(arow['dek_id'], brow['dek_id']);
    assert.notEqual(arow['payload'], brow['payload']);
    assert.equal(JSON.stringify([arow, brow]).includes('CANARY_05'), false);
    assert.equal(
      (await h.db.query('SELECT * FROM app.work_profile_history')).rowCount,
      0,
    );
    const hidden = await owned(
      b.principal.userId,
      async (tx) =>
        (
          await tx.query(
            'SELECT * FROM app.work_profile_history WHERE user_id=$1',
            [a.principal.userId],
          )
        ).rowCount,
    );
    assert.equal(hidden, 0);
    await assert.rejects(
      owned(b.principal.userId, (tx) =>
        tx.query('INSERT INTO app.work_profiles VALUES($1,1)', [
          a.principal.userId,
        ]),
      ),
    );
    await assert.rejects(
      owned(a.principal.userId, (tx) =>
        tx.query(
          "UPDATE app.work_profile_history SET event='updated' WHERE user_id=$1",
          [a.principal.userId],
        ),
      ),
    );
    await assert.rejects(
      owned(a.principal.userId, (tx) =>
        tx.query('DELETE FROM app.work_profile_history WHERE user_id=$1', [
          a.principal.userId,
        ]),
      ),
    );
    const rules = await h.owner.query(
      "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('app.work_profiles'::regclass,'app.work_profile_history'::regclass)",
    );
    assert.equal(
      rules.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity),
      true,
    );
    // Test-only migrator temporarily bypasses the trigger to simulate a database-write attacker.
    async function attacker(sql: string, args: unknown[]) {
      const c = await h.owner.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          'ALTER TABLE app.work_profile_history DISABLE TRIGGER work_history_immutable',
        );
        await c.query(
          "CREATE POLICY pr05_attack ON app.work_profile_history TO forja_migrator USING(user_id::text=current_setting('forja.user_id',true)) WITH CHECK(user_id::text=current_setting('forja.user_id',true))",
        );
        await c.query("SELECT set_config('forja.user_id',$1,true)", [args[0]]);
        const changed = await c.query(sql, args);
        assert.equal(
          changed.rowCount,
          1,
          'attacker actually altered one owner row',
        );
        await c.query('DROP POLICY pr05_attack ON app.work_profile_history');
        await c.query(
          'ALTER TABLE app.work_profile_history ENABLE TRIGGER work_history_immutable',
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    }
    for (const [sql, args] of [
      [
        'UPDATE app.work_profile_history SET payload=$2 WHERE user_id=$1',
        [a.principal.userId, brow['payload']],
      ],
      [
        'UPDATE app.work_profile_history SET recorded_at=$2 WHERE user_id=$1',
        [a.principal.userId, '2026-01-01T00:00:00.000Z'],
      ],
    ] as [string, unknown[]][]) {
      await attacker(sql, args);
      assert.equal(
        (await h.request('work/profile', 'GET', undefined, a.accessToken))
          .status,
        503,
      );
      await attacker(
        'UPDATE app.work_profile_history SET payload=$2,recorded_at=$3 WHERE user_id=$1',
        [a.principal.userId, arow['payload'], arow['recorded_at']],
      );
    }
    await work.replace(a.principal, 1, {
      ...declared,
      occupation: 'NEW_CANARY_05',
    });
    await owned(a.principal.userId, (tx) =>
      tx.query('UPDATE app.work_profiles SET revision=1 WHERE user_id=$1', [
        a.principal.userId,
      ]),
    );
    assert.equal(
      (await h.request('work/profile', 'GET', undefined, a.accessToken)).status,
      503,
    );
    await owned(a.principal.userId, (tx) =>
      tx.query('UPDATE app.work_profiles SET revision=2 WHERE user_id=$1', [
        a.principal.userId,
      ]),
    );
    // Force the final pointer write to fail after encryption and history insertion.
    await h.owner.query(
      "CREATE FUNCTION app.pr05_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Test-only fault'; END $$",
    );
    await h.owner.query(
      'CREATE TRIGGER pr05_fail BEFORE UPDATE ON app.work_profiles FOR EACH ROW EXECUTE FUNCTION app.pr05_fail()',
    );
    try {
      await assert.rejects(
        work.replace(a.principal, 2, {
          ...declared,
          occupation: 'ROLLBACK_CANARY_05',
        }),
      );
    } finally {
      await h.owner.query('DROP TRIGGER pr05_fail ON app.work_profiles');
      await h.owner.query('DROP FUNCTION app.pr05_fail()');
    }
    assert.equal((await work.profile(a.principal)).revision, 2);
    const surviving = await owned(
      a.principal.userId,
      async (tx) =>
        (
          await tx.query(
            'SELECT count(*)::int AS n FROM app.work_profile_history',
          )
        ).rows[0],
    );
    assert.deepEqual(surviving, { n: 2 });
    assert.equal(
      h.lines.some((line) => line.includes('CANARY_05')),
      false,
    );
  } finally {
    await h.close();
  }
});
test('work snapshot dump, final authorization guard, nonce burning, owning readiness and real Identity erasure', async (context) => {
  const h = await harness();
  try {
    let a = await h.login('work-erasure');
    const work = h.module.get(WorkService);
    await work.replace(a.principal, 0, declared);
    const cfg = loadConfig().database,
      passFile = join(
        process.env['CRYPTO_CONTROL_DIRECTORY']!,
        `work-pgpass-${randomUUID()}`,
      );
    const escape = (v: string) =>
      v.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
    writeFileSync(
      passFile,
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
          '--table=app.work_*',
        ],
        {
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            LD_LIBRARY_PATH: '/opt/forja-pg-tools/lib',
            PGPASSFILE: passFile,
            PGOPTIONS: `-c forja.user_id=${a.principal.userId}`,
          },
        },
      );
      assert.equal(dump.status, 0);
      assert.ok(dump.stdout.includes('INSERT INTO app.work_profile_history'));
      for (const forbidden of [
        'CANARY_05',
        '"amountMinor"',
        '"occupation"',
        '"skills"',
        '"availableMinutesPerDay"',
        '"earningModel"',
      ])
        assert.equal(dump.stdout.includes(forbidden), false);
    } finally {
      unlinkSync(passFile);
    }
    const control = new DatabaseSync(
      join(process.env['CRYPTO_CONTROL_DIRECTORY']!, 'lifecycle.sqlite'),
    );
    const counter = () =>
      Number(
        control
          .prepare("SELECT count FROM keys WHERE user_id=? AND state='active'")
          .get(a.principal.userId)?.count,
      );
    const before = counter(),
      transaction = h.db.transaction.bind(h.db);
    context.mock.method(
      h.db,
      'transaction',
      async (operation: (tx: Transaction) => Promise<unknown>) =>
        transaction(async (tx) => {
          tx.beforeCommit(async () => {
            await h.control.revoke(a.principal.sessionId);
          });
          return operation(tx);
        }),
    );
    try {
      await assert.rejects(
        work.replace(a.principal, 1, {
          ...declared,
          occupation: 'FAILED_CANARY_05',
        }),
      );
    } finally {
      context.mock.restoreAll();
    }
    assert.ok(counter() > before);
    assert.equal(
      (await h.request('work/profile', 'GET', undefined, a.accessToken)).status,
      401,
    );
    a = await h.login('work-erasure', 'login');
    control.close();
    assert.equal((await work.profile(a.principal)).revision, 1);
    context.mock.method(work, 'ready', async () => false);
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
    assert.equal(
      (await h.request('work/profile', 'GET', undefined, a.accessToken)).status,
      401,
    );
    await assert.rejects(work.profile(a.principal));
    const empty = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a.principal.userId,
      ]);
      return (
        await tx.query(
          'SELECT (SELECT count(*)::int FROM app.work_profiles) AS current, (SELECT count(*)::int FROM app.work_profile_history) AS history',
        )
      ).rows[0];
    });
    assert.deepEqual(empty, { current: 0, history: 0 });
    assert.equal(
      h.lines.some((line) => line.includes('CANARY_05')),
      false,
    );
  } finally {
    context.mock.restoreAll();
    await h.close();
  }
});
