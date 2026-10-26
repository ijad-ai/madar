import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Pool } from './db.js';

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 4_242_001;

export interface Migration {
  readonly version: string;
  readonly file: string;
  readonly sql: string;
}

export function readMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((file) => MIGRATION_FILE.test(file))
    .sort()
    .map((file) => ({
      version: file.slice(0, 4),
      file,
      sql: readFileSync(join(dir, file), 'utf8'),
    }));
}

/**
 * Apply pending migrations in order, each in its own transaction. An advisory lock
 * keeps two processes from migrating at once. Returns the files it applied.
 */
export async function migrate(pool: Pool, dir: string): Promise<string[]> {
  const migrations = readMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `create table if not exists schema_migrations (
         version text primary key,
         file text not null,
         applied_at timestamptz not null default now()
       )`,
    );
    const done = new Set(
      (await client.query<{ version: string }>('select version from schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );
    for (const migration of migrations) {
      if (done.has(migration.version)) continue;
      await client.query('begin');
      try {
        await client.query(migration.sql);
        await client.query('insert into schema_migrations (version, file) values ($1, $2)', [
          migration.version,
          migration.file,
        ]);
        await client.query('commit');
        applied.push(migration.file);
      } catch (error) {
        await client.query('rollback');
        throw new Error(`migration ${migration.file} failed`, { cause: error });
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

/** Fail closed if the database schema is behind the code. */
export async function assertMigrated(pool: Pool, dir: string): Promise<void> {
  const expected = readMigrations(dir).map((m) => m.version);
  let done: Set<string>;
  try {
    const result = await pool.query<{ version: string }>('select version from schema_migrations');
    done = new Set(result.rows.map((r) => r.version));
  } catch (error) {
    throw new Error('database is not migrated; run `madar migrate`', { cause: error });
  }
  const missing = expected.filter((v) => !done.has(v));
  if (missing.length > 0) {
    throw new Error(`database is missing migrations ${missing.join(', ')}; run \`madar migrate\``);
  }
}
