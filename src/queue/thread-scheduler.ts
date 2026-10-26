import type { Redis } from 'ioredis';

/**
 * Strict per-thread ordering on top of BullMQ (whose built-in grouping is not in the open
 * source edition). Each thread has:
 *
 * - a pending set: every queued job, ordered by the Slack timestamp of its message;
 * - a lock: the job currently allowed to run, as a lease that the running job renews;
 * - a stop request: "cancel every job whose message is at or before this timestamp".
 *
 * A job may run only when it is the head of its thread's pending set and no other job
 * holds the lock. The lock belongs to the job, not the worker, so a job restarted after a
 * worker crash takes its own lock back immediately. Phase 5 keeps the lock while a run
 * waits for approval, so new messages queue behind it.
 */

export interface ThreadRef {
  readonly teamId: string;
  readonly channelId: string;
  readonly threadTs: string;
}

export type AcquireResult =
  | { readonly kind: 'acquired' }
  | { readonly kind: 'waiting'; readonly headJobId: string }
  | { readonly kind: 'locked'; readonly ownerJobId: string }
  | { readonly kind: 'not_registered' };

export interface StopRequest {
  readonly beforeTs: string;
  readonly by: string;
}

const ACQUIRE = `
local head = redis.call('ZRANGE', KEYS[1], 0, 0)[1]
if not head or redis.call('ZSCORE', KEYS[1], ARGV[1]) == false then
  return {'not_registered'}
end
if head ~= ARGV[1] then return {'waiting', head} end
local owner = redis.call('GET', KEYS[2])
if owner and owner ~= ARGV[1] then return {'locked', owner} end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
return {'acquired'}
`;

const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
return 1
`;

// Keep the latest "stop before" timestamp; Slack timestamps compare as decimal numbers.
const REQUEST_STOP = `
local current = redis.call('HGET', KEYS[1], 'before')
if not current or tonumber(ARGV[1]) > tonumber(current) then
  redis.call('HSET', KEYS[1], 'before', ARGV[1], 'by', ARGV[2])
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

const STOP_TTL_SECONDS = 24 * 60 * 60;

export class ThreadScheduler {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'madar',
  ) {}

  key(thread: ThreadRef): string {
    return `${thread.teamId}:${thread.channelId}:${thread.threadTs}`;
  }

  private keys(thread: ThreadRef) {
    const base = `${this.prefix}:thread:${this.key(thread)}`;
    return { pending: `${base}:pending`, lock: `${base}:lock`, stop: `${base}:stop` };
  }

  /** Record a job in its thread's order. Must happen before the job is enqueued. */
  async register(thread: ThreadRef, jobId: string, messageTs: string): Promise<void> {
    await this.redis.zadd(this.keys(thread).pending, 'NX', messageTs, jobId);
  }

  async acquire(thread: ThreadRef, jobId: string, ttlMs: number): Promise<AcquireResult> {
    const { pending, lock } = this.keys(thread);
    const reply = (await this.redis.eval(ACQUIRE, 2, pending, lock, jobId, ttlMs)) as string[];
    switch (reply[0]) {
      case 'acquired':
        return { kind: 'acquired' };
      case 'waiting':
        return { kind: 'waiting', headJobId: reply[1] ?? '' };
      case 'locked':
        return { kind: 'locked', ownerJobId: reply[1] ?? '' };
      default:
        return { kind: 'not_registered' };
    }
  }

  /** Extend the lock. Returns false if this job no longer holds it. */
  async renew(thread: ThreadRef, jobId: string, ttlMs: number): Promise<boolean> {
    const { lock } = this.keys(thread);
    return (await this.redis.eval(RENEW, 1, lock, jobId, ttlMs)) === 1;
  }

  /** Remove a finished job from its thread and free the lock if it held it. */
  async release(thread: ThreadRef, jobId: string): Promise<void> {
    const { pending, lock } = this.keys(thread);
    await this.redis.eval(RELEASE, 2, pending, lock, jobId);
  }

  /** Drop a pending entry whose job no longer exists, so its thread does not stall. */
  async removeStale(thread: ThreadRef, jobId: string): Promise<void> {
    await this.redis.zrem(this.keys(thread).pending, jobId);
  }

  /** Whether a run is active or queued in the thread. */
  async isBusy(thread: ThreadRef): Promise<boolean> {
    const { pending, lock } = this.keys(thread);
    const [locked, queued] = await Promise.all([
      this.redis.exists(lock),
      this.redis.zcard(pending),
    ]);
    return locked === 1 || queued > 0;
  }

  async requestStop(thread: ThreadRef, beforeTs: string, by: string): Promise<void> {
    await this.redis.eval(REQUEST_STOP, 1, this.keys(thread).stop, beforeTs, by, STOP_TTL_SECONDS);
  }

  async stopRequest(thread: ThreadRef): Promise<StopRequest | undefined> {
    const stop = await this.redis.hgetall(this.keys(thread).stop);
    const before = stop['before'];
    return before === undefined ? undefined : { beforeTs: before, by: stop['by'] ?? '' };
  }
}

/** True if a stop request covers the message with this timestamp. */
export function isStopped(stop: StopRequest | undefined, messageTs: string): stop is StopRequest {
  return stop !== undefined && Number(messageTs) <= Number(stop.beforeTs);
}
