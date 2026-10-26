import { spawn, type ChildProcess } from 'node:child_process';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PROGRESS_MARK } from '../../src/agent/context.js';
import { ScriptedRunner } from '../fakes/scripted-runner.js';
import { CHANNEL, Harness } from '../helpers/harness.js';
import { HAS_SERVICES, TEST_REDIS_URL, waitFor } from '../helpers/services.js';

/**
 * Acceptance: "Killing the worker mid-run leaves exactly one outcome in the thread:
 * completed, or interrupted with a notice." Workers run in child processes and are
 * killed with SIGKILL, so nothing in them gets a chance to clean up.
 */
interface Child {
  readonly process: ChildProcess;
  started: number;
}

describe.skipIf(!HAS_SERVICES)('worker crash recovery', { timeout: 60_000 }, () => {
  // The parent runs the gateway side only; workers live in child processes.
  const h = new Harness({ runner: new ScriptedRunner(), startWorker: false });
  const children: Child[] = [];

  beforeAll(async () => {
    await h.start();
  });

  afterEach(() => {
    for (const child of children) child.process.kill('SIGKILL');
    children.length = 0;
  });

  afterAll(async () => {
    await h.stop();
  });

  async function startWorker(delayMs: number): Promise<Child> {
    const proc = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/worker-child.ts'], {
      env: {
        ...process.env,
        TEST_REDIS_URL: TEST_REDIS_URL ?? '',
        CHILD_DATABASE_URL: h.databaseUrl,
        CHILD_SLACK_URL: h.slack.url,
        CHILD_PREFIX: h.prefix,
        CHILD_DELAY_MS: String(delayMs),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const child: Child = { process: proc, started: 0 };
    children.push(child);
    let ready = false;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line === 'ready') ready = true;
        if (line === 'started') child.started += 1;
      }
    });
    await waitFor(() => (ready ? true : undefined), {
      timeoutMs: 20_000,
      what: 'child worker ready',
    });
    return child;
  }

  async function kill(child: Child): Promise<void> {
    const exited = new Promise((resolve) => child.process.once('exit', resolve));
    child.process.kill('SIGKILL');
    await exited;
  }

  const runOf = async (eventId: string) =>
    (await h.runs()).find((r) => r.job_id === `evt-${eventId}`);

  const settled = (threadTs: string) =>
    waitFor(
      async () => {
        const replies = h.replies(threadTs);
        const run = (await h.runs()).find((r) => r.posted);
        return replies.length > 0 &&
          replies.every((r) => !r.startsWith(PROGRESS_MARK)) &&
          run !== undefined
          ? replies
          : undefined;
      },
      { timeoutMs: 30_000, what: 'a settled thread' },
    );

  it('restarts a run once after a crash and posts one answer', async () => {
    const first = await startWorker(60_000);
    const m = await h.mention('survive a crash');
    await waitFor(() => (first.started > 0 ? true : undefined), {
      what: 'run started in first worker',
    });
    await kill(first);

    const second = await startWorker(100);
    const replies = await settled(m.threadTs);
    expect(replies).toEqual(['answer to: survive a crash']);
    expect(h.slack.botReplies(CHANNEL, m.threadTs)).toHaveLength(1);
    expect(second.started).toBe(1);
    expect(await runOf(m.eventId)).toMatchObject({ status: 'completed', attempt: 2, posted: true });
    const edits = h.slack.botReplies(CHANNEL, m.threadTs)[0]?.edits ?? [];
    expect(edits.some((e) => e.includes('Restarted after an interruption'))).toBe(true);
  });

  it('stops after a second crash and leaves one interrupted notice', async () => {
    const first = await startWorker(60_000);
    const m = await h.mention('crash twice');
    await waitFor(() => (first.started > 0 ? true : undefined), {
      what: 'run started in first worker',
    });
    await kill(first);

    const second = await startWorker(60_000);
    await waitFor(() => (second.started > 0 ? true : undefined), {
      timeoutMs: 20_000,
      what: 'restart in second worker',
    });
    await kill(second);

    const third = await startWorker(100);
    const replies = await waitFor(
      () => {
        const r = h.replies(m.threadTs);
        return r.length === 1 && r[0]?.startsWith('This request was interrupted twice')
          ? r
          : undefined;
      },
      { timeoutMs: 30_000, what: 'interrupted notice' },
    );
    expect(replies).toHaveLength(1);
    expect(third.started).toBe(0);
    const run = await waitFor(async () => {
      const r = await runOf(m.eventId);
      return r?.posted === true ? r : undefined;
    });
    expect(run).toMatchObject({ status: 'interrupted', outcome: 'interrupted', attempt: 3 });
  });
});
