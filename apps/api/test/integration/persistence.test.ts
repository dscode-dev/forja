import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database, Transaction } from '../../src/platform/database';
import { loadConfig, migrationConfig } from '../../src/config/config';
import { PlatformFailure } from '../../src/platform/failure';
import { LocalLifecycle } from '../../src/platform/crypto/local-lifecycle';
import {
  LocalKeyProvider,
  localKeyRef,
} from '../../src/platform/crypto/local-provider';
import { UserKeyRepository } from '../../src/platform/crypto/key-repository';
import { UserKeyService } from '../../src/platform/crypto/key-service';
import { fingerprint } from '../../src/platform/crypto/encoding';
import { PayloadContext } from '../../src/platform/crypto/envelope';
const digest = 'd'.repeat(64);
test('real PostgreSQL transactions commit, rollback all writes, translate constraints and invalidate escaped handles', async () => {
  const owner = new Pool(migrationConfig().database);
  const database = new Database(loadConfig());
  let escaped: Transaction | undefined;
  try {
    await owner.query(
      'CREATE TABLE app.pr02_transaction_fixture(id integer PRIMARY KEY,value text NOT NULL); GRANT SELECT,INSERT ON app.pr02_transaction_fixture TO forja_app',
    );
    await database.transaction(async (tx) => {
      escaped = tx;
      await tx.query('INSERT INTO app.pr02_transaction_fixture VALUES($1,$2)', [
        1,
        'TEST_CANARY_02',
      ]);
    });
    await assert.rejects(escaped!.query('SELECT 1'), PlatformFailure);
    await assert.rejects(
      database.query('SELECT $1::integer', ['S3_DB_ERROR_CANARY_02']),
      (e) =>
        e instanceof PlatformFailure &&
        !e.message.includes('S3_DB_ERROR_CANARY_02'),
    );
    for (const failureIndex of [2, 3, 4]) {
      await assert.rejects(
        database.transaction(async (tx) => {
          for (let id = 2; id <= 4; id++) {
            await tx.query(
              'INSERT INTO app.pr02_transaction_fixture VALUES($1,$2)',
              [id, 'TEST_CANARY_02'],
            );
            if (id === failureIndex) throw new Error('TEST_CANARY_02');
          }
        }),
        (e) =>
          e instanceof PlatformFailure && !e.message.includes('TEST_CANARY_02'),
      );
      assert.equal(
        (
          await database.query(
            'SELECT count(*)::int AS n FROM app.pr02_transaction_fixture',
          )
        ).rows[0]?.['n'],
        1,
      );
    }
    await assert.rejects(
      database.transaction(async (tx) => {
        await tx.query(
          'INSERT INTO app.pr02_transaction_fixture VALUES(1,$1)',
          ['TEST_CANARY_02'],
        );
      }),
      (e) =>
        e instanceof PlatformFailure &&
        e.code === 'conflict' &&
        !e.message.includes('TEST_CANARY_02'),
    );
    await assert.rejects(
      database.transaction(async (tx) => {
        await tx.query(
          'INSERT INTO app.pr02_transaction_fixture VALUES(9,$1)',
          ['TEST_CANARY_02'],
        );
        tx.beforeCommit(() => {
          throw new PlatformFailure('fenced');
        });
      }),
      PlatformFailure,
    );
    assert.equal(
      (
        await database.query(
          'SELECT count(*)::int AS n FROM app.pr02_transaction_fixture',
        )
      ).rows[0]?.['n'],
      1,
    );
  } finally {
    await owner.query('DROP TABLE IF EXISTS app.pr02_transaction_fixture');
    await owner.end();
    await database.onApplicationShutdown();
  }
  await assert.rejects(database.query('SELECT 1'), PlatformFailure);
});
test('platform migration replays without schema effects; destructive key rollback is refused', async () => {
  const config = migrationConfig();
  const pool = new Pool(config.database);
  const options = {
    databaseUrl: config.database,
    dir: resolve('migrations'),
    ignorePattern: '(README\\.md|\\..*)',
    direction: 'up' as const,
    migrationsTable: 'schema_migrations',
    migrationsSchema: 'app',
    schema: 'app',
    checkOrder: true,
    singleTransaction: true,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  try {
    assert.equal((await runner(options)).length, 0);
    await assert.rejects(runner({ ...options, direction: 'down', count: 6 }));
    assert.ok(
      (await pool.query("SELECT to_regclass('app.user_data_keys') AS name"))
        .rows[0]?.name,
    );
    const columns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name='user_data_keys'",
    );
    assert.deepEqual(
      columns.rows.map((r) => r.column_name).sort(),
      [
        'user_id',
        'dek_id',
        'dek_version',
        'wrap_format',
        'provider_id',
        'kek_ref',
        'kek_version',
        'wrapped_dek',
        'state',
        'created_at',
      ].sort(),
    );
  } finally {
    await pool.end();
  }
});
test('wrapped-key enrollment, guarded crypto/transaction, DB-only restore and rewrap interruption fail closed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forja-key-integration-'));
  const authority = randomUUID();
  const env = 'forja-test';
  const lifecycle = new LocalLifecycle(
    join(directory, 'control'),
    authority,
    env,
    true,
  );
  const localKey = randomBytes(32);
  const custody = {
    authorityId: authority,
    activeVersion: 1,
    keys: [
      { version: 1, key: localKey.toString('base64') },
      { version: 2, key: randomBytes(32).toString('base64') },
    ],
  };
  for (const key of custody.keys)
    lifecycle.registerWrapping(localKeyRef('forja-test', key.version));
  const provider = new LocalKeyProvider('test', env, custody, lifecycle);
  const database = new Database(loadConfig());
  const repo = new UserKeyRepository(database, env);
  const service = new UserKeyService(env, provider, lifecycle, repo, database);
  const user = randomUUID();
  const other = randomUUID();
  const owner = new Pool(migrationConfig().database);
  try {
    for (const id of [user, other])
      await database.query(
        "INSERT INTO app.users(id,issuer,subject,status) VALUES($1::uuid,'https://pr02-fixture.invalid',$1::text,'pending')",
        [id],
      );
    const identity = await service.provision(user, digest);
    const otherIdentity = await service.provision(other, digest);
    assert.notEqual(identity.dekId, otherIdentity.dekId);
    // Activation completed but PG mirror update was interrupted: reconciliation is idempotent.
    await database.query(
      "UPDATE app.user_data_keys SET state='pending' WHERE dek_id=$1",
      [identity.dekId],
    );
    await service.reconcilePending(identity, digest);
    assert.equal(
      (
        await database.query(
          'SELECT state FROM app.user_data_keys WHERE dek_id=$1',
          [identity.dekId],
        )
      ).rows[0]?.['state'],
      'active',
    );
    const record = await repo.get(identity);
    const generatedDek = await provider.unwrap(record, record.binding);
    const otherWrap = await repo.get(otherIdentity);
    const otherDek = await provider.unwrap(otherWrap, otherWrap.binding);
    try {
      assert.notDeepEqual(generatedDek, otherDek);
      assert.ok(!record.wrapped.equals(generatedDek));
      assert.ok(!record.wrapped.equals(localKey));
    } finally {
      generatedDek.fill(0);
      otherDek.fill(0);
    }

    const rows = await database.query(
      'SELECT * FROM app.user_data_keys WHERE user_id=$1',
      [user],
    );
    assert.ok(Buffer.isBuffer(rows.rows[0]?.['wrapped_dek']));
    assert.ok(!JSON.stringify(rows.rows).includes(localKey.toString('base64')));
    await assert.rejects(
      repo.get({ ...identity, userId: other }),
      PlatformFailure,
    );
    const context: PayloadContext = {
      environment: env,
      userId: user,
      entityKind: 'fixture',
      entityId: randomUUID(),
      slot: 'payload',
      revision: 1,
      metadataSchema: 1,
      metadata: [],
      dekId: identity.dekId,
      dekVersion: identity.version,
      payloadSchema: 1,
    };
    let ciphertext = '',
      decrypted: Buffer | undefined;
    await service.withKey(identity, digest, 'encrypt', async (scope) => {
      ciphertext = await scope.encrypt(
        Buffer.from('{"amount":"S3_CANARY_02"}'),
        context,
      );
      await assert.rejects(
        service.transaction(scope, async () => {
          throw new Error('S3_CANARY_02');
        }),
        PlatformFailure,
      );
      const again = await scope.encrypt(Buffer.from('{}'), context);
      assert.notEqual(JSON.parse(again).nonce, JSON.parse(ciphertext).nonce);
      decrypted = await scope.decrypt(ciphertext, context);
      assert.ok(decrypted.includes(Buffer.from('S3_CANARY_02')));
    });
    assert.equal(
      decrypted!.every((byte) => byte === 0),
      true,
    );
    await owner.query(
      'CREATE TABLE app.pr02_crypto_fixture (id uuid PRIMARY KEY,payload text NOT NULL); GRANT SELECT,INSERT ON app.pr02_crypto_fixture TO forja_app',
    );
    await database.query('INSERT INTO app.pr02_crypto_fixture VALUES($1,$2)', [
      context.entityId,
      ciphertext,
    ]);
    const logicalExport =
      JSON.stringify(
        (await owner.query('SELECT * FROM app.pr02_crypto_fixture')).rows,
      ) + JSON.stringify(rows.rows);
    assert.ok(!logicalExport.includes('S3_CANARY_02'));
    assert.ok(!logicalExport.includes(localKey.toString('base64')));

    await assert.rejects(
      service.withKey(identity, 'e'.repeat(64), 'decrypt', async () => {}),
      PlatformFailure,
    );
    const second = new LocalKeyProvider(
      'test',
      env,
      { ...custody, activeVersion: 2 },
      lifecycle,
    );
    const rotated = await second.rewrap(record, record.binding);
    // Before PG installation: durable intent rolls back safely to the still-persisted wrapper.
    lifecycle.fence(user, 'rewrap');
    lifecycle.stageWrapping(
      identity,
      fingerprint(record),
      fingerprint(rotated),
    );
    await service.reconcileWrapping(identity);
    await service.withKey(identity, digest, 'decrypt', async () => {});

    lifecycle.fence(user, 'rewrap');
    lifecycle.stageWrapping(
      identity,
      fingerprint(record),
      fingerprint(rotated),
    );
    await repo.replace(rotated, record); // Simulate crash before external enrollment; admission stays closed.
    await assert.rejects(
      service.withKey(identity, digest, 'decrypt', async () => {}),
      PlatformFailure,
    );
    const nextService = new UserKeyService(
      env,
      second,
      lifecycle,
      repo,
      database,
    );
    // Also model interruption after control enrollment but before reopening admission.
    lifecycle.replaceWrapping(
      identity,
      fingerprint(record),
      fingerprint(rotated),
    );
    await nextService.reconcileWrapping(identity);
    await nextService.withKey(identity, digest, 'decrypt', async (scope) => {
      assert.ok(
        (await scope.decrypt(ciphertext, context)).includes(
          Buffer.from('S3_CANARY_02'),
        ),
      );
    });
    await repo.replace(record, rotated); // Restoring only PostgreSQL cannot resurrect the old wrap fingerprint.
    await assert.rejects(
      nextService.withKey(identity, digest, 'decrypt', async () => {}),
      PlatformFailure,
    );
    await repo.replace(rotated, record);
    await nextService.withKey(identity, digest, 'encrypt', async (scope) => {
      const fresh = await scope.encrypt(Buffer.from('{}'), context);
      assert.equal(
        Buffer.from(JSON.parse(fresh).nonce, 'base64').readBigUInt64BE(4),
        3n,
      );
    });
    second.close();
    const replacement = lifecycle.createPending(user, digest);
    const pendingKey = randomBytes(32);
    const pendingWrap = await provider.wrap(pendingKey, {
      environment: env,
      ...replacement,
    });
    pendingKey.fill(0);
    await repo.insert(pendingWrap);
    await assert.rejects(
      service.reconcilePending(replacement, digest),
      PlatformFailure,
    );
    lifecycle.fence(user);
    await service.reconcilePending(replacement, digest);
    assert.equal(lifecycle.state(identity), 'decrypt-only');
    lifecycle.fence(user);
    lifecycle.transition(user, 'deleted');
    await assert.rejects(
      service.withKey(replacement, digest, 'decrypt', async () => {}),
      PlatformFailure,
    );
    // Synthetic canary stays only in the test database; wrapped-key rows never contain raw key columns.
    const sql = await owner.query(
      "SELECT encode(wrapped_dek,'hex') AS wrapped FROM app.user_data_keys WHERE user_id=$1",
      [user],
    );
    assert.ok(sql.rows.every((r) => r.wrapped !== localKey.toString('hex')));
  } finally {
    await owner.query('DROP TABLE IF EXISTS app.pr02_crypto_fixture');
    await owner.query(
      'DELETE FROM app.user_data_keys WHERE user_id = ANY($1::uuid[])',
      [[user, other]],
    );
    await owner.query('DELETE FROM app.users WHERE id=ANY($1::uuid[])', [
      [user, other],
    ]);
    await owner.end();
    await database.onApplicationShutdown();
    provider.close();
    lifecycle.close();
    localKey.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});
