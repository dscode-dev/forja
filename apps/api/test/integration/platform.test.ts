import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../../src/app.module';
import { migrationConfig, loadConfig } from '../../src/config/config';
import { SafeErrorFilter } from '../../src/platform/error-filter';
import { SafeLogger } from '../../src/platform/safe-logger';
import { CryptoPlatform } from '../../src/platform/crypto/crypto-platform';
import { Database } from '../../src/platform/database';
import { AUTH_CONTROL, AuthControl } from '../../src/platform/auth-control';
test('actual HTTP readiness checks PostgreSQL and runtime role lacks schema creation', async () => {
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.useGlobalFilters(new SafeErrorFilter(new SafeLogger(() => {})));
  await app.listen(0, '127.0.0.1');
  const pool = new Pool(loadConfig().database);
  try {
    for (const route of ['live', 'ready']) {
      const response = await fetch(`${await app.getUrl()}/health/${route}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { status: 'ok' });
    }
    const result = await pool.query(
      "SELECT current_user AS name, has_schema_privilege(current_user, 'app', 'CREATE') AS can_create",
    );
    assert.equal(result.rows[0]?.name, 'forja_app');
    assert.equal(result.rows[0]?.can_create, false);
  } finally {
    await pool.end();
    await app.close();
  }
});
test('migrations run transactionally, are tracked and replay without duplicating schema effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forja-migration-test-'));
  const config = migrationConfig();
  const pool = new Pool(config.database);
  try {
    await writeFile(
      join(directory, '1700000000000-fixture.cjs'),
      'exports.up = pgm => pgm.createTable("pr01_fixture", { id: { type: "integer", primaryKey: true } });',
    );
    const options = {
      databaseUrl: config.database,
      dir: directory,
      direction: 'up' as const,
      migrationsTable: 'pr01_test_migrations',
      migrationsSchema: 'app',
      schema: 'app',
      singleTransaction: true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const first = await runner(options);
    const second = await runner(options);
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS total FROM app.pr01_test_migrations',
        )
      ).rows[0]?.total,
      1,
    );
    await writeFile(
      join(directory, '1700000000001-failing-fixture.cjs'),
      'exports.up = pgm => { pgm.createTable("pr01_rollback_fixture", { id: { type: "integer" } }); pgm.sql("SELECT 1 / 0"); };',
    );
    await assert.rejects(runner(options));
    assert.equal(
      (
        await pool.query(
          "SELECT to_regclass('app.pr01_rollback_fixture') AS name",
        )
      ).rows[0]?.name,
      null,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS total FROM app.pr01_test_migrations',
        )
      ).rows[0]?.total,
      1,
    );
  } finally {
    await pool.query(
      'DROP TABLE IF EXISTS app.pr01_fixture, app.pr01_rollback_fixture, app.pr01_test_migrations',
    );
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

test('database failure returns sanitized readiness 503 while liveness stays available', async () => {
  const config = loadConfig();
  const unavailable = new Database({
    ...config,
    database: { ...config.database, port: 1 },
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Database)
    .useValue(unavailable)
    .compile();
  const app = module.createNestApplication({ logger: false });
  app.useGlobalFilters(new SafeErrorFilter(new SafeLogger(() => {})));
  await app.listen(0, '127.0.0.1');
  try {
    const response = await fetch(`${await app.getUrl()}/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'UNAVAILABLE' });
    assert.equal(
      (await fetch(`${await app.getUrl()}/health/live`)).status,
      200,
    );
  } finally {
    await app.close();
  }
});

test('real local lifecycle outage fails HTTP readiness safely while liveness remains available', async () => {
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  const events: string[] = [];
  app.useGlobalFilters(
    new SafeErrorFilter(new SafeLogger((line) => events.push(line))),
  );
  await app.listen(0, '127.0.0.1');
  try {
    module.get(CryptoPlatform).lifecycle.close();
    const ready = await fetch(`${await app.getUrl()}/health/ready`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { code: 'UNAVAILABLE' });
    assert.equal(
      (await fetch(`${await app.getUrl()}/health/live`)).status,
      200,
    );
    assert.deepEqual(events, [
      '{"event":"http.request.failed","result":"unavailable"}',
    ]);
  } finally {
    await app.close();
  }
});

test('independent session authority outage denies readiness without exposing internals', async () => {
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.useGlobalFilters(new SafeErrorFilter(new SafeLogger(() => {})));
  await app.listen(0, '127.0.0.1');
  try {
    await module.get<AuthControl>(AUTH_CONTROL).close();
    const response = await fetch(`${await app.getUrl()}/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'UNAVAILABLE' });
    assert.equal(
      (await fetch(`${await app.getUrl()}/health/live`)).status,
      200,
    );
  } finally {
    await app.close();
  }
});
