import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  DEAD_DATABASE_URL,
  HAS_SERVICES,
} from '../../test/helpers/services.js';
import { createPool, type Pool } from './db.js';
import { assertMigrated, migrate } from './migrate.js';
import { PgRunStore, type RunKey } from './run-store.js';

let pool: Pool;
let store: PgRunStore;
let drop: () => Promise<void>;
let seq = 0;

function key(overrides: Partial<RunKey> = {}): RunKey {
  seq += 1;
  return {
    jobId: `evt-Ev${seq}`,
    eventId: `Ev${seq}`,
    teamId: 'T0FAKE0001',
    channelId: 'C0TEST0001',
    threadTs: '1761000000.000001',
    messageTs: `1761000000.${String(seq).padStart(6, '0')}`,
    requesterId: 'U0ALICE001',
    projectId: 'demo',
    queuedAt: new Date(),
    ...overrides,
  };
}

const init = { model: 'claude-sonnet-5-5', promptVersion: 'p1' };

describe.skipIf(!HAS_SERVICES)('PgRunStore (Postgres)', () => {
  beforeAll(async () => {
    const db = await createTestDatabase();
    drop = db.drop;
    pool = createPool({ connectionString: db.url, applicationName: 'madar-test' });
    expect(await migrate(pool, 'migrations')).toEqual(['0001_runs_and_audit.sql']);
    store = new PgRunStore(pool);
  });

  afterAll(async () => {
    await pool.end();
    await drop();
  });

  it('is idempotent to migrate twice, and reports the schema as current', async () => {
    expect(await migrate(pool, 'migrations')).toEqual([]);
    await expect(assertMigrated(pool, 'migrations')).resolves.toBeUndefined();
  });

  it('starts a run once, then reports a restart, then reports it finished', async () => {
    const k = key();
    const first = await store.begin(k, init);
    expect(first.state).toBe('new');
    expect(first.run).toMatchObject({ status: 'running', attempt: 1, postedAt: null });

    const second = await store.begin(k, init);
    expect(second.state).toBe('restarted');
    expect(second.run.attempt).toBe(2);
    expect(second.run.id).toBe(first.run.id);

    await store.setPlaceholder(first.run.id, '1761000000.999999');
    await store.finish(first.run.id, {
      status: 'completed',
      outcome: 'completed',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.001,
        turns: 1,
      },
    });
    const third = await store.begin(k, init);
    expect(third.state).toBe('finished');
    expect(third.run).toMatchObject({ status: 'completed', placeholderTs: '1761000000.999999' });

    await store.markPosted(first.run.id);
    expect((await store.getByJobId(k.jobId))?.postedAt).toBeInstanceOf(Date);
  });

  it('refuses to finish a run twice', async () => {
    const { run } = await store.begin(key(), init);
    await store.finish(run.id, { status: 'cancelled', outcome: 'cancelled' });
    await expect(
      store.finish(run.id, { status: 'completed', outcome: 'completed' }),
    ).rejects.toThrow(/is not running/);
  });

  it('records start, restart and finish in the audit log, with no message content', async () => {
    const k = key();
    const { run } = await store.begin(k, { ...init, correlationId: 'corr-1' });
    await store.begin(k, init);
    await store.finish(run.id, {
      status: 'failed',
      outcome: 'model_api_error',
      details: { status: 401 },
    });
    const events = await pool.query<{ kind: string; actor: string | null; data: unknown }>(
      'select kind, actor, data from audit_events where run_id = $1 order by id',
      [run.id],
    );
    expect(events.rows.map((e) => e.kind)).toEqual([
      'run.started',
      'run.restarted',
      'run.finished',
    ]);
    expect(events.rows[0]?.actor).toBe('U0ALICE001');
    expect(events.rows[2]?.data).toMatchObject({ outcome: 'model_api_error', status: 401 });
  });

  it('keeps the audit log append-only', async () => {
    await store.appendEvent({ kind: 'test.event' });
    await expect(pool.query("update audit_events set kind = 'x'")).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from audit_events')).rejects.toThrow(/append-only/);
    await expect(pool.query('truncate audit_events')).rejects.toThrow(/append-only/);
  });

  it('fails fast when Postgres is unreachable', async () => {
    const dead = createPool({
      connectionString: DEAD_DATABASE_URL,
      applicationName: 'madar-test',
      connectTimeoutMs: 500,
    });
    const started = Date.now();
    await expect(new PgRunStore(dead).begin(key(), init)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
    await dead.end();
  });
});
