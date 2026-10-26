import { Redis } from 'ioredis';
import { pino, type Logger } from 'pino';

import type { AgentRunner } from '../../src/agent/runner.js';
import { PROMPT_VERSION, SYSTEM_PROMPT } from '../../src/agent/system-prompt.js';
import { createPool, type Pool } from '../../src/audit/db.js';
import { migrate } from '../../src/audit/migrate.js';
import { PgRunStore } from '../../src/audit/run-store.js';
import { parseProjectMap } from '../../src/authz/projects.js';
import { EventDeduper, UserRateLimiter } from '../../src/gateway/guards.js';
import {
  handleMention,
  type MentionDeps,
  type MentionOutcome,
} from '../../src/gateway/mention-handler.js';
import { createWebClient, WebClientSlackApi } from '../../src/gateway/slack-api.js';
import { BullRunProducer } from '../../src/queue/producer.js';
import {
  DEFAULT_SETTINGS,
  RunProcessor,
  type RunProcessorSettings,
} from '../../src/queue/run-processor.js';
import { ThreadScheduler } from '../../src/queue/thread-scheduler.js';
import { createRunQueue, startRunWorker, type RunWorker } from '../../src/queue/worker.js';
import { FAKE_BOT_ID, FAKE_BOT_USER, FAKE_TEAM, FakeSlackApi } from '../fakes/slack-api.js';
import { clearRedisPrefix, createTestDatabase, TEST_REDIS_URL, uniqueName } from './services.js';

export const CHANNEL = 'C0ENABLED1';
export const OTHER_CHANNEL = 'C0NOTMAPPD';

export interface HarnessOptions {
  readonly runner: AgentRunner;
  readonly settings?: Partial<RunProcessorSettings>;
  readonly concurrency?: number;
  /** Start a worker in this process. Crash tests run workers in child processes instead. */
  readonly startWorker?: boolean;
  readonly ratePerHour?: number;
  /** Override the run store's database, for "audit store down" tests. */
  readonly runStoreDatabaseUrl?: string;
}

/** Fast timings so stalled-job and lock-expiry paths finish in seconds, not minutes. */
export const FAST_TIMINGS = {
  lockTtlMs: 2_000,
  lockRenewMs: 500,
  stopPollMs: 100,
  progressEveryMs: 100,
  heartbeatMs: 1_000,
  retryDelayMs: 100,
} satisfies Partial<RunProcessorSettings>;

export const FAST_QUEUE = { lockDurationMs: 1_500, stalledIntervalMs: 500 };

/**
 * The whole Phase 1 stack minus Bolt: real Redis, Postgres, BullMQ, Slack WebClient (against
 * a fake Slack API) and the real gateway handler and run processor.
 */
export class Harness {
  readonly slack = new FakeSlackApi();
  readonly prefix = uniqueName('madar-t');
  readonly logger: Logger = pino({ level: process.env['TEST_LOG_LEVEL'] ?? 'silent' });
  databaseUrl = '';
  pool!: Pool;
  store!: PgRunStore;
  redis!: Redis;
  workerRedis!: Redis;
  scheduler!: ThreadScheduler;
  mentionDeps!: MentionDeps;
  processor!: RunProcessor;
  worker: RunWorker | undefined;
  private dropDb: (() => Promise<void>) | undefined;
  private eventSeq = 0;
  private storePool: Pool | undefined;

  constructor(private readonly options: HarnessOptions) {}

  async start(): Promise<this> {
    await this.slack.start();
    const db = await createTestDatabase();
    this.databaseUrl = db.url;
    this.dropDb = db.drop;
    this.pool = createPool({ connectionString: db.url, applicationName: 'madar-test' });
    await migrate(this.pool, 'migrations');
    this.storePool =
      this.options.runStoreDatabaseUrl === undefined
        ? undefined
        : createPool({
            connectionString: this.options.runStoreDatabaseUrl,
            applicationName: 'madar-test',
            connectTimeoutMs: 500,
          });
    this.store = new PgRunStore(this.storePool ?? this.pool);

    this.redis = new Redis(TEST_REDIS_URL ?? '', { maxRetriesPerRequest: 1 });
    this.workerRedis = new Redis(TEST_REDIS_URL ?? '', { maxRetriesPerRequest: null });
    this.scheduler = new ThreadScheduler(this.redis, this.prefix);
    const queue = createRunQueue(this.redis, this.prefix);
    const slackApi = new WebClientSlackApi(
      createWebClient({
        token: 'xoxb-test',
        apiUrl: this.slack.url,
        logger: this.logger,
        retries: 0,
      }),
    );
    this.mentionDeps = {
      projects: parseProjectMap({
        projects: [{ id: 'demo', name: 'Demo', slackChannels: [CHANNEL] }],
      }),
      slack: slackApi,
      producer: new BullRunProducer(queue, this.scheduler),
      scheduler: this.scheduler,
      deduper: new EventDeduper(this.redis, this.prefix),
      rateLimiter: new UserRateLimiter(this.redis, this.options.ratePerHour ?? 100, this.prefix),
      ratePerHour: this.options.ratePerHour ?? 100,
      logger: this.logger,
    };
    this.processor = new RunProcessor({
      scheduler: this.scheduler,
      queue,
      store: this.store,
      slack: slackApi,
      runner: this.options.runner,
      bot: { userId: FAKE_BOT_USER, botId: FAKE_BOT_ID },
      logger: this.logger,
      settings: {
        ...DEFAULT_SETTINGS,
        ...FAST_TIMINGS,
        model: 'scripted',
        promptVersion: PROMPT_VERSION,
        systemPrompt: SYSTEM_PROMPT,
        ...this.options.settings,
      },
    });
    if (this.options.startWorker ?? true) {
      this.worker = await startRunWorker(
        this.processor,
        queue,
        {
          connection: this.workerRedis,
          prefix: this.prefix,
          concurrency: this.options.concurrency ?? 4,
          globalConcurrency: undefined,
          ...FAST_QUEUE,
        },
        this.logger,
      );
    }
    return this;
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.redis.quit();
    await this.workerRedis.quit();
    await this.pool.end();
    await this.storePool?.end();
    await clearRedisPrefix(this.prefix);
    await this.dropDb?.();
    await this.slack.stop();
  }

  /** A person posts a message mentioning the bot; the gateway handles the event. */
  async mention(
    words: string,
    opts: { threadTs?: string; user?: string; channel?: string; eventId?: string } = {},
  ): Promise<{ ts: string; threadTs: string; eventId: string; outcome: MentionOutcome }> {
    const channel = opts.channel ?? CHANNEL;
    const message = this.slack.addUserMessage(channel, `<@${FAKE_BOT_USER}> ${words}`, {
      ...(opts.threadTs === undefined ? {} : { threadTs: opts.threadTs }),
      ...(opts.user === undefined ? {} : { user: opts.user }),
    });
    this.eventSeq += 1;
    const eventId = opts.eventId ?? `Ev${this.prefix.slice(-8)}${String(this.eventSeq)}`;
    const outcome = await this.deliver(
      eventId,
      message.text,
      message.ts,
      channel,
      opts.threadTs,
      message.user,
    );
    return { ts: message.ts, threadTs: opts.threadTs ?? message.ts, eventId, outcome };
  }

  /** Deliver an event again, as Slack does on a retry. */
  async deliver(
    eventId: string,
    words: string,
    ts: string,
    channel = CHANNEL,
    threadTs?: string,
    user: string | undefined = 'U0ALICE001',
  ): Promise<MentionOutcome> {
    return handleMention(
      { eventId, teamId: FAKE_TEAM, channel, user, botId: undefined, text: words, ts, threadTs },
      FAKE_BOT_USER,
      this.mentionDeps,
    );
  }

  /** The bot's replies in a thread, oldest first. */
  replies(threadTs: string, channel = CHANNEL): string[] {
    return this.slack.botReplies(channel, threadTs).map((m) => m.text);
  }

  async runs(): Promise<
    { job_id: string; status: string; outcome: string | null; attempt: number; posted: boolean }[]
  > {
    const result = await this.pool.query<{
      job_id: string;
      status: string;
      outcome: string | null;
      attempt: number;
      posted: boolean;
    }>(
      'select job_id, status, outcome, attempt, posted_at is not null as posted from runs order by started_at',
    );
    return result.rows;
  }
}
