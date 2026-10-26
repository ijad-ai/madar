import type { Redis } from 'ioredis';

/**
 * Slack retries an event it thinks we missed, and can deliver the same event twice.
 * The event id is stable across retries, so the first delivery wins.
 */
export class EventDeduper {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'madar',
    private readonly ttlSeconds = 24 * 60 * 60,
  ) {}

  async firstTime(eventId: string): Promise<boolean> {
    const result = await this.redis.set(
      `${this.prefix}:dedupe:event:${eventId}`,
      '1',
      'EX',
      this.ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }
}

const COUNT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/** A fixed one-hour window per user (threat T23). */
export class UserRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly perHour: number,
    private readonly prefix = 'madar',
  ) {}

  async allow(userId: string, now = Date.now()): Promise<boolean> {
    const window = Math.floor(now / 3_600_000);
    const key = `${this.prefix}:ratelimit:user:${userId}:${window}`;
    const count = (await this.redis.eval(COUNT, 1, key, 3_600)) as number;
    return count <= this.perHour;
  }
}
