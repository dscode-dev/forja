import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { CONFIG, RuntimeConfig } from '../config/config';
import { databaseFailure, PlatformFailure } from './failure';
export interface SqlExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}
export interface Transaction extends SqlExecutor {
  beforeCommit(check: () => void | Promise<void>): void;
}
@Injectable()
export class Database implements OnApplicationShutdown, SqlExecutor {
  private readonly pool: Pool;
  private closing = false;
  constructor(@Inject(CONFIG) config: RuntimeConfig) {
    this.pool = new Pool({
      ...config.database,
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      query_timeout: 3000,
      statement_timeout: 3000,
      idle_in_transaction_session_timeout: 5000,
      application_name: 'forja-api',
    });
    this.pool.on('error', () => {});
  }
  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    if (this.closing) throw new PlatformFailure('unavailable');
    try {
      return await this.pool.query<R>(sql, [...parameters]);
    } catch (error) {
      throw databaseFailure(error);
    }
  }
  async transaction<T>(
    operation: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    if (this.closing) throw new PlatformFailure('unavailable');
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new PlatformFailure('unavailable');
    }
    let open = false,
      finished = false,
      committing = false,
      discard = false;
    const checks: (() => void | Promise<void>)[] = [];
    const tx: Transaction = {
      query: async <R extends QueryResultRow>(
        sql: string,
        parameters: readonly unknown[] = [],
      ) => {
        if (finished) throw new PlatformFailure('invalid');
        try {
          return await client.query<R>(sql, [...parameters]);
        } catch (error) {
          throw databaseFailure(error);
        }
      },
      beforeCommit: (check) => {
        if (finished) throw new PlatformFailure('invalid');
        checks.push(check);
      },
    };
    try {
      await client.query('BEGIN');
      open = true;
      const value = await operation(tx);
      for (const check of checks) await check();
      finished = true;
      committing = true;
      await client.query('COMMIT');
      open = false;
      return value;
    } catch (error) {
      finished = true;
      if (open) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true;
        }
      }
      if (committing) {
        discard = true;
        throw new PlatformFailure('commit_unknown');
      }
      throw databaseFailure(error);
    } finally {
      finished = true;
      client.release(discard);
    }
  }
  async ready(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    await this.pool.end();
  }
}
