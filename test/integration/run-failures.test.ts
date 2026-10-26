import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROGRESS_MARK } from '../../src/agent/context.js';
import { text } from '../../src/gateway/messages.js';
import { ScriptedRunner } from '../fakes/scripted-runner.js';
import { CHANNEL, Harness } from '../helpers/harness.js';
import { HAS_SERVICES, waitFor } from '../helpers/services.js';

/** Failure paths after the agent has answered. */
describe.skipIf(!HAS_SERVICES)('run failures after the answer', { timeout: 30_000 }, () => {
  let failFinalEdit = false;
  let h: Harness;
  const runner = new ScriptedRunner(() => {
    // Make the next chat.update (the final answer) fail, as if Slack went down.
    if (failFinalEdit) h.slack.failNext('chat.update', 'internal_error');
    return { delayMs: 50, text: 'an answer that never arrives' };
  });

  beforeAll(async () => {
    h = await new Harness({ runner }).start();
  });

  afterAll(async () => {
    await h.stop();
  });

  it('records the run, posts nothing misleading, and leaves the reply marked unfinished', async () => {
    failFinalEdit = true;
    const m = await h.mention('slack fails at the end');
    const run = await waitFor(async () =>
      (await h.runs()).find((r) => r.job_id === `evt-${m.eventId}` && r.status !== 'running'),
    );
    expect(run).toMatchObject({ status: 'completed', posted: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const replies = h.replies(m.threadTs);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.startsWith(PROGRESS_MARK)).toBe(true);
    const everything = h.slack.botReplies(CHANNEL, m.threadTs).flatMap((r) => [r.text, ...r.edits]);
    expect(everything).not.toContain(text.auditUnavailable);
    expect(everything.some((t) => t.startsWith('Something went wrong'))).toBe(false);
  });

  it('says the answer was lost if the same job is delivered again', async () => {
    failFinalEdit = true;
    const m = await h.mention('lost then redelivered');
    await waitFor(async () =>
      (await h.runs()).find((r) => r.job_id === `evt-${m.eventId}` && r.status === 'completed'),
    );
    failFinalEdit = false;
    // Deliver the job to the processor again, as BullMQ would after a lost ack.
    await h.processor.process(
      {
        id: `evt-${m.eventId}`,
        data: {
          v: 1,
          eventId: m.eventId,
          teamId: 'T0FAKE0001',
          channelId: CHANNEL,
          threadTs: m.threadTs,
          messageTs: m.ts,
          requesterId: 'U0ALICE001',
          projectId: 'demo',
          placeholderTs: h.slack.botReplies(CHANNEL, m.threadTs)[0]?.ts,
          receivedAt: Date.now(),
        },
      } as never,
      undefined,
    );
    expect(h.replies(m.threadTs)).toEqual([text.lostBeforePosting(await runId(m.eventId))]);
    expect((await h.runs()).find((r) => r.job_id === `evt-${m.eventId}`)?.posted).toBe(true);
  });

  async function runId(eventId: string): Promise<string> {
    const result = await h.pool.query<{ id: string }>('select id from runs where job_id = $1', [
      `evt-${eventId}`,
    ]);
    return result.rows[0]?.id ?? '';
  }
});
