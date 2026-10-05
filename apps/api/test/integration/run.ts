import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { localKeyRef } from '../../src/platform/crypto/local-provider';
import { LocalLifecycle } from '../../src/platform/crypto/local-lifecycle';
const directory = mkdtempSync(join(tmpdir(), 'forja-integration-'));
const secret = join(directory, 'custody');
const authority = randomUUID();
writeFileSync(
  secret,
  JSON.stringify({
    authorityId: authority,
    activeVersion: 1,
    keys: [{ version: 1, key: randomBytes(32).toString('base64') }],
  }),
  { mode: 0o600 },
);
const control = new LocalLifecycle(
  join(directory, 'lifecycle.sqlite'),
  authority,
  'forja-test',
  true,
);
control.registerWrapping(localKeyRef('forja-test', 1));
control.close();
try {
  const tls = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'pipe' },
  );
  if (tls.status !== 0)
    throw new Error('Test-only TLS fixture generation failed');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DB_NAME: 'forja_test',
    CRYPTO_ENVIRONMENT_ID: 'forja-test',
    CRYPTO_SECRET_FILE: secret,
    CRYPTO_CONTROL_DIRECTORY: directory,
    FORJA_TEST_TLS_DIRECTORY: directory,
    NODE_EXTRA_CA_CERTS: join(directory, 'cert.pem'),
  };
  const migrate = spawnSync(process.execPath, ['dist-test/src/migrate.js'], {
    stdio: 'inherit',
    env,
  });
  if (migrate.status !== 0) throw new Error('Test migration failed');
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      'dist-test/test/integration/platform.test.js',
      'dist-test/test/integration/persistence.test.js',
      'dist-test/test/integration/identity.test.js',
      'dist-test/test/integration/finance.test.js',
    ],
    { stdio: 'inherit', env },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
