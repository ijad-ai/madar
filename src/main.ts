import { Redis } from 'ioredis';

import { ClaudeAgentRunner } from './agent/claude-runner.js';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './agent/system-prompt.js';
import { createPool } from './audit/db.js';
import { assertMigrated, migrate } from './audit/migrate.js';
import { PgRunStore } from './audit/run-store.js';
import { loadProjectMap } from './authz/projects.js';
import {
  describeConfig,
  loadConfigFromProcess,
  requireRole,
  ROLES,
  type Role,
} from './config/index.js';
import { createSlackApp } from './gateway/app.js';
import { EventDeduper, UserRateLimiter } from './gateway/guards.js';
import { createWebClient, WebClientSlackApi } from './gateway/slack-api.js';
import { BullRunProducer } from './queue/producer.js';
import { DEFAULT_SETTINGS, RunProcessor } from './queue/run-processor.js';
import { ThreadScheduler } from './queue/thread-scheduler.js';
import { createRunQueue, startRunWorker } from './queue/worker.js';
import { createLogger } from './shared/logger.js';

const MIGRATIONS_DIR = 'migrations';

/**
 * Entry point. `madar <role>`:
 *   gateway  Slack events in, placeholders and commands out, runs enqueued.
 *   worker   Runs from the queue through the agent; holds the Claude API key.
 *   all      Both, in one process (local development).
 *   migrate  Apply database migrations and exit.
 */
async function main(): Promise<void> {
  const role = (process.argv[2] ?? 'all') as Role;
  if (!ROLES.includes(role)) {
    throw new Error(`unknown role "${role}"; expected one of ${ROLES.join(', ')}`);
  }
  const config = loadConfigFromProcess();
  requireRole(config, role);
  const logger = createLogger({ level: config.logLevel, serviceName: config.serviceName }).child({
    role,
  });
  logger.info({ config: describeConfig(config) }, 'starting');

  const cleanups: (() => Promise<unknown>)[] = [];
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    for (const cleanup of cleanups.reverse()) {
      await cleanup().catch((error: unknown) => {
        logger.warn({ err: error }, 'cleanup step failed');
      });
    }
    process.exit(0);
  };
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(1);
      stopping = true;
      void shutdown(signal);
    });
  }

  if (role === 'migrate') {
    const migratePool = createPool({
      connectionString: config.databaseUrl,
      applicationName: 'madar-migrate',
    });
    try {
      const applied = await migrate(migratePool, MIGRATIONS_DIR);
      logger.info(
        { applied },
        applied.length === 0 ? 'database already up to date' : 'migrations applied',
      );
    } finally {
      await migratePool.end();
    }
    return;
  }

  // The gateway never touches Postgres; the worker refuses to start on an old schema.
  const pool =
    role === 'gateway'
      ? undefined
      : createPool({ connectionString: config.databaseUrl, applicationName: `madar-${role}` });
  if (pool !== undefined) {
    cleanups.push(() => pool.end());
    await assertMigrated(pool, MIGRATIONS_DIR);
  }

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect();
  cleanups.push(() => redis.quit());

  const projects = loadProjectMap(config.projectsFile);
  if (projects.channelCount === 0) {
    logger.warn(
      { file: config.projectsFile },
      'the project map lists no channels; the bot will answer nowhere',
    );
  }

  const webClient = createWebClient({
    token: required(config.slack.botToken, 'SLACK_BOT_TOKEN'),
    apiUrl: config.slack.apiUrl,
    logger,
  });
  const auth = await webClient.auth.test();
  if (auth.user_id === undefined) throw new Error('auth.test returned no bot user id');
  logger.info(
    { botUserId: auth.user_id, team: auth.team_id, channels: projects.channelCount },
    'Slack token verified',
  );
  const slack = new WebClientSlackApi(webClient);
  const scheduler = new ThreadScheduler(redis, config.redisKeyPrefix);
  const queue = createRunQueue(redis, config.redisKeyPrefix);
  cleanups.push(() => queue.close());

  if (role === 'worker' || role === 'all') {
    const workerRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    cleanups.push(() => workerRedis.quit());
    const runner = new ClaudeAgentRunner({
      apiKey: required(config.agent.apiKey, 'ANTHROPIC_API_KEY'),
      baseUrl: config.agent.baseUrl,
      model: config.agent.model,
      budgets: {
        maxTurns: config.agent.maxTurns,
        maxTokens: config.agent.maxTokens,
        maxCostUsd: config.agent.maxCostUsd,
        timeoutMs: config.agent.timeoutSeconds * 1_000,
      },
      apiMaxRetries: config.agent.apiMaxRetries,
      workDir: config.agent.workDir,
      logger,
    });
    const processor = new RunProcessor({
      scheduler,
      queue,
      store: new PgRunStore(required(pool, 'a database pool')),
      slack,
      runner,
      bot: { userId: auth.user_id, botId: auth.bot_id },
      logger,
      settings: {
        ...DEFAULT_SETTINGS,
        model: config.agent.model,
        promptVersion: PROMPT_VERSION,
        systemPrompt: SYSTEM_PROMPT,
      },
    });
    const worker = await startRunWorker(
      processor,
      queue,
      {
        connection: workerRedis,
        prefix: config.redisKeyPrefix,
        concurrency: config.queue.workerConcurrency,
        globalConcurrency: config.queue.globalConcurrency,
      },
      logger,
    );
    cleanups.push(() => worker.close());
    logger.info({ concurrency: config.queue.workerConcurrency }, 'worker consuming runs');
  }

  if (role === 'gateway' || role === 'all') {
    const { app } = createSlackApp({
      slack: config.slack,
      deps: {
        projects,
        slack,
        producer: new BullRunProducer(queue, scheduler),
        scheduler,
        deduper: new EventDeduper(redis, config.redisKeyPrefix),
        rateLimiter: new UserRateLimiter(
          redis,
          config.queue.ratePerUserPerHour,
          config.redisKeyPrefix,
        ),
        ratePerHour: config.queue.ratePerUserPerHour,
        logger,
      },
      logger,
    });
    if (config.slack.transport === 'http') await app.start(config.slack.httpPort);
    else await app.start();
    cleanups.push(() => app.stop());
    logger.info({ transport: config.slack.transport }, 'gateway listening for Slack events');
  }
}

/** requireRole has already checked these; this keeps the types honest without `!`. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is required`);
  return value;
}

main().catch((error: unknown) => {
  // The logger may not exist yet (bad config), so write a plain line to stderr.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`madar failed to start: ${message}\n`);
  process.exit(1);
});
