import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROGRESS_MARK } from '../../src/agent/context.js';
import { FakeAnthropicApi } from '../fakes/anthropic-api.js';
import { FAKE_BOT_USER, FAKE_TEAM, FakeSlackApi } from '../fakes/slack-api.js';
import {
  clearRedisPrefix,
  createTestDatabase,
  HAS_SERVICES,
  TEST_REDIS_URL,
  uniqueName,
  waitFor,
} from '../helpers/services.js';

const SECRET = 'main-process-signing-secret-01';
const CHANNEL = 'C0MAINPROC1';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

function run(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** The real entry point, all roles in one process, against fake Slack and fake Claude APIs. */
describe.skipIf(!HAS_SERVICES)('madar process (src/main.ts)', { timeout: 60_000 }, () => {
  const slack = new FakeSlackApi();
  const api = new FakeAnthropicApi();
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let env: NodeJS.ProcessEnv;
  let child: ChildProcess | undefined;
  let port = 0;
  let output = '';
  const prefix = uniqueName('madar_p');

  beforeAll(async () => {
    await slack.start();
    await api.start();
    db = await createTestDatabase();
    port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), 'madar-main-'));
    const projectsFile = join(dir, 'projects.json');
    writeFileSync(
      projectsFile,
      JSON.stringify({ projects: [{ id: 'main', name: 'Main', slackChannels: [CHANNEL] }] }),
    );
    env = {
      PATH: process.env['PATH'],
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      REDIS_URL: TEST_REDIS_URL,
      REDIS_KEY_PREFIX: prefix,
      DATABASE_URL: db.url,
      PROJECTS_FILE: projectsFile,
      SLACK_TRANSPORT: 'http',
      SLACK_HTTP_PORT: String(port),
      SLACK_BOT_TOKEN: 'xoxb-main-process-test',
      SLACK_SIGNING_SECRET: SECRET,
      SLACK_API_URL: slack.url,
      ANTHROPIC_API_KEY: 'sk-test-not-real',
      ANTHROPIC_BASE_URL: api.url,
      AGENT_API_MAX_RETRIES: '0',
      AGENT_WORK_DIR: dir,
    };
  });

  afterAll(async () => {
    child?.kill('SIGKILL');
    await clearRedisPrefix(prefix);
    await db.drop();
    await slack.stop();
    await api.stop();
  });

  it('refuses to start before the database is migrated', async () => {
    const proc = run(['worker'], env);
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise((resolve) => proc.once('exit', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('database is not migrated');
  });

  it('migrates, starts, answers a signed mention, and shuts down cleanly', async () => {
    const migrateCode = await new Promise((resolve) => run(['migrate'], env).once('exit', resolve));
    expect(migrateCode).toBe(0);

    child = run(['all'], env);
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    await waitFor(
      () => (output.includes('gateway listening for Slack events') ? true : undefined),
      {
        timeoutMs: 20_000,
        what: 'gateway to start',
      },
    );

    api.handler = () => ({ kind: 'text', text: 'Main process answer.' });
    const message = slack.addUserMessage(
      CHANNEL,
      `<@${FAKE_BOT_USER}> hello from the process test`,
    );
    const body = JSON.stringify({
      team_id: FAKE_TEAM,
      api_app_id: 'A0FAKEAPP1',
      type: 'event_callback',
      event_id: 'EvMainProc0001',
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [{ team_id: FAKE_TEAM, user_id: FAKE_BOT_USER, is_bot: true }],
      event: {
        type: 'app_mention',
        user: 'U0ALICE001',
        text: message.text,
        ts: message.ts,
        channel: CHANNEL,
        event_ts: message.ts,
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
    const response = await fetch(`http://127.0.0.1:${String(port)}/slack/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': signature,
      },
      body,
    });
    expect(response.status).toBe(200);

    const replies = await waitFor(
      () => {
        const r = slack.botReplies(CHANNEL, message.ts).map((m) => m.text);
        return r.length === 1 && !r[0]?.startsWith(PROGRESS_MARK) ? r : undefined;
      },
      { timeoutMs: 30_000, what: 'answer from the process' },
    );
    expect(replies).toEqual(['Main process answer.']);
    expect(output).not.toContain('xoxb-main-process-test');
    expect(output).not.toContain('sk-test-not-real');

    const exited = new Promise((resolve) => child?.once('exit', resolve));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    child = undefined;
  });
});
