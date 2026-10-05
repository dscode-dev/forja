import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const CONFIG = Symbol('CONFIG');
export interface RuntimeConfig {
  readonly environment: 'development' | 'test' | 'production';
  readonly crypto: {
    readonly provider: 'local-development';
    readonly environmentId: string;
    readonly secretFile: string;
    readonly controlDirectory: string;
  };
  readonly host: string;
  readonly port: number;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly ssl:
      false | { readonly ca: string; readonly rejectUnauthorized: true };
  };
}
export class ConfigurationError extends Error {
  constructor(readonly field: string) {
    super(`Invalid configuration: ${field}`);
  }
}
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim() !== value) throw new ConfigurationError(key);
  return value;
}
function port(env: NodeJS.ProcessEnv, key: string): number {
  const value = required(env, key);
  if (!/^\d+$/.test(value) || +value < 1 || +value > 65535)
    throw new ConfigurationError(key);
  return +value;
}
function secretFile(env: NodeJS.ProcessEnv, key: string): string {
  const path = required(env, key);
  if (!isAbsolute(path)) throw new ConfigurationError(key);
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (!value || value.length > 65536) throw new Error();
    return value;
  } catch {
    throw new ConfigurationError(key);
  }
}
function databaseSettings(
  env: NodeJS.ProcessEnv,
): Pick<RuntimeConfig, 'environment' | 'database'> {
  for (const key of Object.keys(env)) {
    if (/(^|_)(KEK|DEK)(_|$)|(^|_)ENCRYPTION_KEY($|_)/.test(key))
      throw new ConfigurationError('KEY_MATERIAL');
  }
  if (env['DB_PASSWORD'] || env['DATABASE_URL'])
    throw new ConfigurationError('DATABASE_SECRET_SOURCE');
  const environment = required(env, 'NODE_ENV');
  if (!['development', 'test', 'production'].includes(environment))
    throw new ConfigurationError('NODE_ENV');
  const mode = required(env, 'DB_SSL_MODE');
  let ssl: RuntimeConfig['database']['ssl'];
  if (mode === 'disable' && environment !== 'production') ssl = false;
  else if (mode === 'verify-full')
    ssl = { ca: secretFile(env, 'DB_SSL_CA_FILE'), rejectUnauthorized: true };
  else throw new ConfigurationError('DB_SSL_MODE');
  const host = required(env, 'DB_HOST');
  if (!ssl && !['postgres', 'localhost', '127.0.0.1', '::1'].includes(host))
    throw new ConfigurationError('DB_HOST');
  return Object.freeze({
    environment: environment as RuntimeConfig['environment'],
    database: Object.freeze({
      host,
      port: port(env, 'DB_PORT'),
      database: required(env, 'DB_NAME'),
      user: required(env, 'DB_USER'),
      password: secretFile(env, 'DB_PASSWORD_FILE'),
      ssl,
    }),
  });
}
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const settings = databaseSettings(env);
  const environment = settings.environment;
  const provider = required(env, 'CRYPTO_PROVIDER');
  if (environment === 'production' || provider !== 'local-development')
    throw new ConfigurationError('CRYPTO_PROVIDER');
  const environmentId = required(env, 'CRYPTO_ENVIRONMENT_ID');
  if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(environmentId))
    throw new ConfigurationError('CRYPTO_ENVIRONMENT_ID');
  const cryptoSecretFile = required(env, 'CRYPTO_SECRET_FILE');
  const controlDirectory = required(env, 'CRYPTO_CONTROL_DIRECTORY');
  if (!isAbsolute(cryptoSecretFile) || !isAbsolute(controlDirectory))
    throw new ConfigurationError('CRYPTO_PATH');
  return Object.freeze({
    ...settings,
    crypto: Object.freeze({
      provider: 'local-development' as const,
      environmentId,
      secretFile: cryptoSecretFile,
      controlDirectory,
    }),
    host: required(env, 'APP_BIND_HOST'),
    port: port(env, 'PORT'),
  });
}
export function migrationConfig(
  env: NodeJS.ProcessEnv = process.env,
): Pick<RuntimeConfig, 'environment' | 'database'> {
  return databaseSettings({
    ...env,
    DB_USER: env['MIGRATION_USER'],
    DB_PASSWORD_FILE: env['MIGRATION_PASSWORD_FILE'],
  });
}
