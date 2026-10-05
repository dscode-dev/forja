import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  migrationConfig,
  ConfigurationError,
} from '../src/config/config';
const directory = mkdtempSync(join(tmpdir(), 'forja-config-test-'));
const passwordFile = join(directory, 'password');
writeFileSync(passwordFile, 'TEST_SECRET_CANARY\n');
after(() => rmSync(directory, { recursive: true, force: true }));
const valid = {
  NODE_ENV: 'test',
  CRYPTO_PROVIDER: 'local-development',
  CRYPTO_ENVIRONMENT_ID: 'forja-test',
  CRYPTO_SECRET_FILE: '/tmp/test-custody',
  CRYPTO_CONTROL_DIRECTORY: '/tmp/test-control',
  APP_BIND_HOST: '127.0.0.1',
  PORT: '3001',
  DB_HOST: 'postgres',
  DB_PORT: '5432',
  DB_NAME: 'forja_test',
  DB_USER: 'forja_app',
  DB_PASSWORD_FILE: passwordFile,
  DB_SSL_MODE: 'disable',
};
test('missing settings and malformed ports fail without revealing input', () => {
  for (const field of Object.keys(valid)) {
    const env: NodeJS.ProcessEnv = { ...valid };
    delete env[field];
    assert.throws(() => loadConfig(env), ConfigurationError);
  }
  for (const value of ['0', '65536', '3001.1', 'secret', ' 3001']) {
    assert.throws(
      () => loadConfig({ ...valid, PORT: value }),
      (error: unknown) =>
        error instanceof ConfigurationError && !error.message.includes(value),
    );
  }
});
test('secret source is file-only and config rejects key material', () => {
  assert.equal(loadConfig(valid).database.password, 'TEST_SECRET_CANARY');
  for (const env of [
    { DB_PASSWORD: 'TEST_SECRET_CANARY' },
    { DATABASE_URL: 'TEST_SECRET_CANARY' },
    { PRODUCTION_KEK: 'TEST_SECRET_CANARY' },
  ]) {
    assert.throws(
      () => loadConfig({ ...valid, ...env }),
      (e: unknown) =>
        e instanceof ConfigurationError &&
        !e.message.includes('TEST_SECRET_CANARY'),
    );
  }
  assert.throws(
    () => loadConfig({ ...valid, DB_PASSWORD_FILE: 'relative' }),
    ConfigurationError,
  );
});
test('production requires verified database TLS; insecure remote development also fails', () => {
  assert.throws(
    () => loadConfig({ ...valid, NODE_ENV: 'production' }),
    ConfigurationError,
  );
  assert.throws(
    () => loadConfig({ ...valid, DB_HOST: 'remote.example.invalid' }),
    ConfigurationError,
  );
  assert.throws(
    () =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        DB_SSL_MODE: 'verify-full',
      }),
    ConfigurationError,
  );
});

test('production refuses local custody even with DB TLS; migrator does not depend on a key provider', () => {
  const env = {
    ...valid,
    NODE_ENV: 'production',
    DB_SSL_MODE: 'verify-full',
    DB_SSL_CA_FILE: passwordFile,
    MIGRATION_USER: 'migrator',
    MIGRATION_PASSWORD_FILE: passwordFile,
  };
  assert.throws(
    () => loadConfig(env),
    (e) => e instanceof ConfigurationError && e.field === 'CRYPTO_PROVIDER',
  );
  const config = migrationConfig(env);
  assert.notEqual(config.database.ssl, false);
  assert.throws(
    () => loadConfig({ ...valid, CRYPTO_PROVIDER: 'managed' }),
    ConfigurationError,
  );
});
