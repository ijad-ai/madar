import { randomBytes } from 'node:crypto';

import { Redis } from 'ioredis';
import pg from 'pg';

/**
 * Integration tests need real Redis and Postgres. They read TEST_REDIS_URL and
 * TEST_DATABASE_URL and are skipped when those are unset, unless REQUIRE_INTEGRATION=1
 * (set in CI), in which case a missing service fails the run instead of hiding it.
 */
export const TEST_REDIS_URL = process.env['TEST_REDIS_URL'];
export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
export const HAS_SERVICES = TEST_REDIS_URL !== undefined && TEST_DATABASE_URL !== undefined;

if (process.env['REQUIRE_INTEGRATION'] === '1' && !HAS_SERVICES) {
  throw new Error('REQUIRE_INTEGRATION=1 but TEST_REDIS_URL or TEST_DATABASE_URL is unset');
}

export function uniqueName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

/** Create a fresh, empty database for one test file. Returns its URL and a cleanup. */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  if (TEST_DATABASE_URL === undefined) throw new Error('TEST_DATABASE_URL is unset');
  const name = uniqueName('madar_t');
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      await client.query(`drop database if exists ${name} with (force)`);
      await client.end();
    },
  };
}

/** Delete every Redis key under a prefix. Tests use a unique prefix each. */
export async function clearRedisPrefix(prefix: string): Promise<void> {
  if (TEST_REDIS_URL === undefined) return;
  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
  await redis.quit();
}

/** A Postgres URL nothing listens on, for "audit store down" tests. */
export const DEAD_DATABASE_URL = 'postgres://madar:x@127.0.0.1:1/madar';

/** Poll until `check` returns a value other than undefined, or time out. */
export async function waitFor<T>(
  check: () => T | undefined | Promise<T | undefined>,
  { timeoutMs = 10_000, intervalMs = 25, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
