import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRedisPrefix,
  HAS_SERVICES,
  TEST_REDIS_URL,
  uniqueName,
} from '../../test/helpers/services.js';
import { isStopped, ThreadScheduler, type ThreadRef } from './thread-scheduler.js';

let redis: Redis;
let scheduler: ThreadScheduler;
const prefix = uniqueName('madar-t');
let n = 0;

function thread(): ThreadRef {
  n += 1;
  return {
    teamId: 'T0FAKE0001',
    channelId: 'C0TEST0001',
    threadTs: `1761000000.${String(n).padStart(6, '0')}`,
  };
}

describe.skipIf(!HAS_SERVICES)('ThreadScheduler (Redis)', () => {
  beforeAll(() => {
    redis = new Redis(TEST_REDIS_URL ?? '', { maxRetriesPerRequest: 1 });
    scheduler = new ThreadScheduler(redis, prefix);
  });

  afterAll(async () => {
    await clearRedisPrefix(prefix);
    await redis.quit();
  });

  it('runs jobs in message order, one at a time', async () => {
    const t = thread();
    await scheduler.register(t, 'evt-b', '1761000001.000002');
    await scheduler.register(t, 'evt-a', '1761000001.000001');
    expect(await scheduler.acquire(t, 'evt-b', 5_000)).toEqual({
      kind: 'waiting',
      headJobId: 'evt-a',
    });
    expect(await scheduler.acquire(t, 'evt-a', 5_000)).toEqual({ kind: 'acquired' });
    await scheduler.release(t, 'evt-a');
    expect(await scheduler.acquire(t, 'evt-b', 5_000)).toEqual({ kind: 'acquired' });
  });

  it('lets a restarted job take back its own lock', async () => {
    const t = thread();
    await scheduler.register(t, 'evt-1', '1761000002.000001');
    expect((await scheduler.acquire(t, 'evt-1', 60_000)).kind).toBe('acquired');
    expect((await scheduler.acquire(t, 'evt-1', 60_000)).kind).toBe('acquired');
  });

  it('keeps a lock owned by another job until it expires', async () => {
    const t = thread();
    await scheduler.register(t, 'evt-old', '1761000003.000001');
    expect((await scheduler.acquire(t, 'evt-old', 200)).kind).toBe('acquired');
    await scheduler.removeStale(t, 'evt-old');
    await scheduler.register(t, 'evt-new', '1761000003.000002');
    expect(await scheduler.acquire(t, 'evt-new', 5_000)).toEqual({
      kind: 'locked',
      ownerJobId: 'evt-old',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await scheduler.acquire(t, 'evt-new', 5_000)).kind).toBe('acquired');
  });

  it('renews only for the owner, and keeps threads independent', async () => {
    const a = thread();
    const b = thread();
    await scheduler.register(a, 'evt-a1', '1761000004.000001');
    await scheduler.register(b, 'evt-b1', '1761000004.000002');
    expect((await scheduler.acquire(a, 'evt-a1', 5_000)).kind).toBe('acquired');
    expect((await scheduler.acquire(b, 'evt-b1', 5_000)).kind).toBe('acquired');
    expect(await scheduler.renew(a, 'evt-a1', 5_000)).toBe(true);
    expect(await scheduler.renew(a, 'evt-b1', 5_000)).toBe(false);
  });

  it('reports unregistered jobs and busy threads', async () => {
    const t = thread();
    expect(await scheduler.isBusy(t)).toBe(false);
    expect(await scheduler.acquire(t, 'evt-x', 5_000)).toEqual({ kind: 'not_registered' });
    await scheduler.register(t, 'evt-x', '1761000005.000001');
    expect(await scheduler.isBusy(t)).toBe(true);
    await scheduler.release(t, 'evt-x');
    expect(await scheduler.isBusy(t)).toBe(false);
  });

  it('keeps the latest stop request and applies it to earlier messages only', async () => {
    const t = thread();
    await scheduler.requestStop(t, '1761000006.000005', 'U0ALICE001');
    await scheduler.requestStop(t, '1761000006.000003', 'U0BOB00001');
    const stop = await scheduler.stopRequest(t);
    expect(stop).toEqual({ beforeTs: '1761000006.000005', by: 'U0ALICE001' });
    expect(isStopped(stop, '1761000006.000004')).toBe(true);
    expect(isStopped(stop, '1761000006.000006')).toBe(false);
    expect(isStopped(undefined, '1761000006.000001')).toBe(false);
  });
});
