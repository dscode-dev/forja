import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { LocalLifecycle } from '../src/platform/crypto/local-lifecycle';
import { PlatformFailure } from '../src/platform/failure';
const digest = 'a'.repeat(64),
  fp = 'b'.repeat(64);
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'forja-lifecycle-'));
  const path = join(directory, 'control');
  const authority = randomUUID();
  const store = new LocalLifecycle(path, authority, 'forja-test', true);
  const key = store.createPending(randomUUID(), digest);
  store.enroll(key, fp);
  store.activate(key, fp);
  return { directory, path, authority, store, key };
}
test('independent durable counters survive reopen, burn unused allocations and enforce annual/hard/soft limits', () => {
  const f = setup();
  let store = f.store;
  try {
    const lease = store.admit(f.key, digest, fp, 'encrypt');
    const first = store.reserve(lease);
    store.release(lease);
    store.close();
    store = new LocalLifecycle(f.path, f.authority, 'forja-test');
    const next = store.admit(f.key, digest, fp, 'encrypt');
    assert.equal(
      store.reserve(next).readBigUInt64BE(4),
      first.readBigUInt64BE(4) + 1n,
    );
    const db = new DatabaseSync(f.path);
    db.prepare('UPDATE keys SET count=? WHERE dek_id=?').run(
      2 ** 31,
      f.key.dekId,
    );
    assert.equal(store.rotationDue(f.key), true);
    db.prepare('UPDATE keys SET count=? WHERE dek_id=?').run(
      2 ** 32,
      f.key.dekId,
    );
    assert.throws(() => store.reserve(next), PlatformFailure);
    db.prepare('UPDATE keys SET count=0,created=0 WHERE dek_id=?').run(
      f.key.dekId,
    );
    assert.throws(() => store.reserve(next), PlatformFailure);
    db.close();
    store.release(next);
    assert.throws(
      () => new LocalLifecycle(f.path, randomUUID(), 'forja-test'),
      PlatformFailure,
    );
    assert.throws(
      () =>
        new LocalLifecycle(
          join(f.directory, 'lost'),
          f.authority,
          'forja-test',
        ),
      PlatformFailure,
    );
  } finally {
    store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test('fencing denies new admissions, drains existing operations and prevents deletion/rotation before release', () => {
  const f = setup();
  try {
    const lease = f.store.admit(f.key, digest, fp, 'encrypt');
    const replacement = f.store.createPending(f.key.userId, digest);
    f.store.enroll(replacement, fp);
    f.store.fence(f.key.userId);
    assert.throws(
      () => f.store.admit(f.key, digest, fp, 'decrypt'),
      PlatformFailure,
    );
    f.store.assertAdmission(lease);
    assert.throws(() => f.store.activate(replacement, fp), PlatformFailure);
    assert.throws(
      () => f.store.transition(f.key.userId, 'deleted'),
      PlatformFailure,
    );
    f.store.release(lease);
    f.store.activate(replacement, fp);
    assert.equal(f.store.state(f.key), 'decrypt-only');
    assert.throws(
      () => f.store.admit(f.key, digest, fp, 'encrypt'),
      PlatformFailure,
    );
    const read = f.store.admit(f.key, digest, fp, 'decrypt');
    f.store.release(read);
    assert.throws(
      () => f.store.admit(replacement, 'c'.repeat(64), fp, 'decrypt'),
      PlatformFailure,
    );
    f.store.fence(f.key.userId);
    f.store.transition(f.key.userId, 'deleted');
    assert.throws(() => f.store.active(f.key.userId), PlatformFailure);
    assert.throws(
      () => f.store.createPending(f.key.userId, digest),
      PlatformFailure,
    );
  } finally {
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test('parallel processes share one atomic never-reused allocation namespace', async () => {
  const f = setup();
  try {
    const jobs = Array.from(
      { length: 4 },
      () =>
        new Promise<string[]>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              'dist-test/test/fixtures/nonce-worker.js',
              f.path,
              f.authority,
              JSON.stringify(f.key),
              digest,
              fp,
            ],
            { stdio: ['ignore', 'pipe', 'ignore'] },
          );
          let output = '';
          child.stdout.on('data', (data: Buffer) => {
            output += data.toString();
          });
          child.on('error', reject);
          child.on('exit', (code) => {
            if (code !== 0) reject(new Error('worker failed'));
            else resolve(JSON.parse(output) as string[]);
          });
        }),
    );
    const values = (await Promise.all(jobs)).flat();
    assert.equal(values.length, 200);
    assert.equal(new Set(values).size, 200);
  } finally {
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('loss of a wrapping allocation namespace is not recreated by provider restart', async () => {
  const f = setup();
  try {
    const { LocalKeyProvider, localKeyRef } =
      await import('../src/platform/crypto/local-provider.js');
    const { randomBytes } = await import('node:crypto');
    const custody = {
      authorityId: f.authority,
      activeVersion: 1,
      keys: [{ version: 1, key: randomBytes(32).toString('base64') }],
    };
    const ref = localKeyRef('forja-test', 1);
    f.store.registerWrapping(ref);
    const provider = new LocalKeyProvider(
      'test',
      'forja-test',
      custody,
      f.store,
    );
    const db = new DatabaseSync(f.path);
    db.prepare('DELETE FROM wrapping WHERE scope=?').run(ref);
    db.close();
    assert.equal(await provider.ready(), false);
    provider.close();
    assert.throws(
      () => new LocalKeyProvider('test', 'forja-test', custody, f.store),
      PlatformFailure,
    );
  } finally {
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
