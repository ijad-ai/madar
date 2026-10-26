import pg from 'pg';

export type Pool = pg.Pool;

export interface PoolOptions {
  readonly connectionString: string;
  readonly applicationName: string;
  /** Fail fast when Postgres is down, so the agent refuses quickly instead of hanging. */
  readonly connectTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly max?: number;
}

export function createPool(options: PoolOptions): Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 3_000,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
    idleTimeoutMillis: 30_000,
    max: options.max ?? 10,
  });
  // An idle client losing its connection must not crash the process; the next query fails
  // instead, and callers treat that as "audit store unavailable".
  pool.on('error', () => undefined);
  return pool;
}
