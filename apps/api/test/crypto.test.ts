import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aad,
  open,
  seal,
  parseEnvelope,
  PayloadContext,
} from '../src/platform/crypto/envelope';
import { LocalLifecycle } from '../src/platform/crypto/local-lifecycle';
import {
  LocalKeyProvider,
  localKeyRef,
} from '../src/platform/crypto/local-provider';
import { fingerprint } from '../src/platform/crypto/encoding';
import { PlatformFailure } from '../src/platform/failure';
const context: PayloadContext = {
  environment: 'forja-test',
  userId: randomUUID(),
  entityKind: 'fixture',
  entityId: randomUUID(),
  slot: 'payload',
  revision: 1,
  metadataSchema: 1,
  metadata: ['USD', null, 1, true],
  dekId: randomUUID(),
  dekVersion: 1,
  payloadSchema: 1,
};
test('maintained AES-256-GCM primitive matches published zero-key/IV known-answer vector', () => {
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.alloc(32),
    Buffer.alloc(12),
    { authTagLength: 16 },
  );
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.alloc(16)),
    cipher.final(),
  ]);
  assert.equal(ciphertext.toString('hex'), 'cea7403d4d606b6e074ec5d3baf39d18');
  assert.equal(
    cipher.getAuthTag().toString('hex'),
    'd0d1c8a799996bf0265b98b5d48ab919',
  );
});
test('envelope roundtrip authenticates every context binding and returns bytes only after final authentication', () => {
  const key = randomBytes(32),
    plaintext = Buffer.from('{"sensitive":"FINANCIAL_CANARY_02"}');
  const serialized = seal(key, Buffer.alloc(12), plaintext, context);
  assert.deepEqual(open(key, serialized, context), plaintext);
  assert.ok(!serialized.includes('FINANCIAL_CANARY_02'));
  for (const change of [
    { environment: 'forja-other' },
    { userId: randomUUID() },
    { entityKind: 'other' },
    { entityId: randomUUID() },
    { slot: 'other' },
    { revision: 2 },
    { metadataSchema: 2 },
    { metadata: ['EUR', null, 1, true] },
    { dekId: randomUUID() },
    { dekVersion: 2 },
    { payloadSchema: 2 },
  ])
    assert.throws(
      () => open(key, serialized, { ...context, ...change }),
      PlatformFailure,
    );
  assert.throws(
    () => open(randomBytes(32), serialized, context),
    PlatformFailure,
  );
  const envelope = JSON.parse(serialized) as Record<string, unknown>;
  for (const field of ['nonce', 'ciphertext', 'tag']) {
    const bytes = Buffer.from(envelope[field] as string, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    assert.throws(
      () =>
        open(
          key,
          JSON.stringify({ ...envelope, [field]: bytes.toString('base64') }),
          context,
        ),
      PlatformFailure,
    );
  }
  assert.equal(
    aad(context).toString(),
    JSON.stringify([
      'forja',
      1,
      context.environment,
      context.userId,
      'fixture',
      context.entityId,
      'payload',
      1,
      1,
      ['USD', null, 1, true],
      context.dekId,
      1,
      1,
      'AES-256-GCM',
    ]),
  );
});
test('strict envelope parser rejects duplicate/extra fields, noncanonical Base64, versions, sizes and JSON ambiguity', () => {
  const serialized = seal(
    randomBytes(32),
    Buffer.alloc(12),
    Buffer.from('{}'),
    context,
  );
  const value = JSON.parse(serialized) as Record<string, unknown>;
  for (const invalid of [
    serialized.replace('{', '{"format":1,'),
    JSON.stringify({ ...value, extra: 1 }),
    JSON.stringify({ ...value, format: 2 }),
    JSON.stringify({ ...value, algorithm: 'AES-128-GCM' }),
    JSON.stringify({ ...value, tag: 'AA==' }),
    JSON.stringify({
      ...value,
      nonce: (value['nonce'] as string).slice(0, -1),
    }),
    JSON.stringify({ ...value, dek_version: 0 }),
    JSON.stringify({ ...value, payload_schema: 1.5 }),
    ' '.repeat(1400501),
    '{"__proto__":{}}',
  ])
    assert.throws(() => parseEnvelope(invalid), PlatformFailure);
  assert.throws(
    () =>
      seal(randomBytes(32), Buffer.alloc(12), Buffer.alloc(1048577), context),
    PlatformFailure,
  );
});
test('real development provider wraps distinct keys, binds owner/environment/version and rewraps without changing DEK', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forja-provider-'));
  const authority = randomUUID();
  const lifecycle = new LocalLifecycle(
    join(directory, 'control'),
    authority,
    'forja-test',
    true,
  );
  const custody = {
    authorityId: authority,
    activeVersion: 1,
    keys: [
      { version: 1, key: randomBytes(32).toString('base64') },
      { version: 2, key: randomBytes(32).toString('base64') },
    ],
  };
  for (const key of custody.keys)
    lifecycle.registerWrapping(localKeyRef('forja-test', key.version));
  const provider = new LocalKeyProvider(
    'test',
    'forja-test',
    custody,
    lifecycle,
  );
  const binding = {
    environment: 'forja-test',
    userId: randomUUID(),
    dekId: randomUUID(),
    version: 1,
  };
  const key = randomBytes(32);
  try {
    const record = await provider.wrap(key, binding);
    assert.deepEqual(await provider.unwrap(record, binding), key);
    const next = await provider.wrap(randomBytes(32), {
      ...binding,
      userId: randomUUID(),
      dekId: randomUUID(),
    });
    assert.notDeepEqual(record.wrapped, next.wrapped);
    for (const change of [
      { userId: randomUUID() },
      { dekId: randomUUID() },
      { environment: 'foreign' },
      { version: 2 },
    ])
      await assert.rejects(
        provider.unwrap(record, { ...binding, ...change }),
        PlatformFailure,
      );
    await assert.rejects(
      provider.unwrap({ ...record, kekVersion: 2 }, binding),
      PlatformFailure,
    );
    const wrong = new LocalKeyProvider(
      'test',
      'forja-test',
      {
        ...custody,
        keys: [{ version: 1, key: randomBytes(32).toString('base64') }],
      },
      lifecycle,
    );
    await assert.rejects(wrong.unwrap(record, binding), PlatformFailure);
    wrong.close();
    const second = new LocalKeyProvider(
      'test',
      'forja-test',
      { ...custody, activeVersion: 2 },
      lifecycle,
    );
    const rewrapped = await second.rewrap(record, binding);
    assert.equal(rewrapped.kekVersion, 2);
    assert.deepEqual(await second.unwrap(rewrapped, binding), key);
    assert.notEqual(fingerprint(record), fingerprint(rewrapped));
    second.close();
    assert.throws(
      () =>
        new LocalKeyProvider('production', 'forja-test', custody, lifecycle),
      PlatformFailure,
    );
  } finally {
    key.fill(0);
    provider.close();
    lifecycle.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
