import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { migrationConfig } from './config/config';
import { SafeLogger } from './platform/safe-logger';
async function migrate(): Promise<void> {
  const config = migrationConfig();
  const logger = new SafeLogger();
  await runner({
    databaseUrl: config.database,
    dir: resolve('migrations'),
    ignorePattern: '(README\\.md|\\..*)',
    direction: 'up',
    migrationsTable: 'schema_migrations',
    migrationsSchema: 'app',
    schema: 'app',
    createSchema: false,
    count: Infinity,
    checkOrder: true,
    singleTransaction: true,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  logger.event('migration.completed', 'success');
}
void migrate().catch(() => {
  new SafeLogger().event('migration.failed', 'unavailable');
  process.exitCode = 1;
});
