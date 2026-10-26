/**
 * A real worker process for crash tests. The parent test starts it, waits until it is
 * mid-run, then kills it with SIGKILL, exactly as a crashed host would.
 *
 * Env: TEST_REDIS_URL, CHILD_DATABASE_URL, CHILD_SLACK_URL, CHILD_PREFIX, CHILD_DELAY_MS.
 * Prints "ready" once consuming, and "started" each time the agent starts a run.
 */
import { Redis } from 'ioredis';
import { pino } from 'pino';

import { PROMPT_VERSION, SYSTEM_PROMPT } from '../../src/agent/system-prompt.js';
import { createPool } from '../../src/audit/db.js';
import { PgRunStore } from '../../src/audit/run-store.js';
import { createWebClient, WebClientSlackApi } from '../../src/gateway/slack-api.js';
import { DEFAULT_SETTINGS, RunProcessor } from '../../src/queue/run-processor.js';
import { ThreadScheduler } from '../../src/queue/thread-scheduler.js';
import { createRunQueue, startRunWorker } from '../../src/queue/worker.js';
import { FAKE_BOT_ID, FAKE_BOT_USER } from '../fakes/slack-api.js';
import { lastMessageText, ScriptedRunner } from '../fakes/scripted-runner.js';
import { FAST_QUEUE, FAST_TIMINGS } from './harness.js';

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

const logger = pino({ level: process.env['TEST_LOG_LEVEL'] ?? 'silent' });
const prefix = env('CHILD_PREFIX');
const delayMs = Number(env('CHILD_DELAY_MS'));
const redis = new Redis(env('TEST_REDIS_URL'), { maxRetriesPerRequest: 1 });
const workerRedis = new Redis(env('TEST_REDIS_URL'), { maxRetriesPerRequest: null });
const pool = createPool({
  connectionString: env('CHILD_DATABASE_URL'),
  applicationName: 'madar-child',
});
const queue = createRunQueue(redis, prefix);
const runner = new ScriptedRunner((request) => {
  process.stdout.write('started\n');
  return {
    delayMs,
    text: `answer to: ${lastMessageText(request.prompt).replace(/^@Madar\s*/, '')}`,
  };
});

const processor = new RunProcessor({
  scheduler: new ThreadScheduler(redis, prefix),
  queue,
  store: new PgRunStore(pool),
  slack: new WebClientSlackApi(
    createWebClient({ token: 'xoxb-test', apiUrl: env('CHILD_SLACK_URL'), logger, retries: 0 }),
  ),
  runner,
  bot: { userId: FAKE_BOT_USER, botId: FAKE_BOT_ID },
  logger,
  settings: {
    ...DEFAULT_SETTINGS,
    ...FAST_TIMINGS,
    model: 'scripted',
    promptVersion: PROMPT_VERSION,
    systemPrompt: SYSTEM_PROMPT,
  },
});

await startRunWorker(
  processor,
  queue,
  { connection: workerRedis, prefix, concurrency: 2, globalConcurrency: undefined, ...FAST_QUEUE },
  logger,
);
process.stdout.write('ready\n');
