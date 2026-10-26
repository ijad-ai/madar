import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROGRESS_MARK } from '../../src/agent/context.js';
import { UserRateLimiter } from '../../src/gateway/guards.js';
import { handleMention } from '../../src/gateway/mention-handler.js';
import { text } from '../../src/gateway/messages.js';
import { lastMessageText, ScriptedRunner } from '../fakes/scripted-runner.js';
import { Harness, OTHER_CHANNEL } from '../helpers/harness.js';
import { DEAD_DATABASE_URL, HAS_SERVICES, waitFor } from '../helpers/services.js';

/** Instructions for the scripted agent ride in the message text: "[delay=300] question". */
function scriptFromPrompt(prompt: string) {
  const last = lastMessageText(prompt);
  const delay = /\[delay=(\d+)\]/.exec(last)?.[1];
  return {
    delayMs: delay === undefined ? 50 : Number(delay),
    text: `answer to: ${last.replace(/^@Madar\s*/, '')}`,
    progress: last.includes('[progress]') ? 'thinking about it' : undefined,
  };
}

const finalReply = (h: Harness, threadTs: string) =>
  waitFor(
    () => {
      const replies = h.replies(threadTs);
      return replies.length > 0 && replies.every((r) => !r.startsWith(PROGRESS_MARK))
        ? replies
        : undefined;
    },
    { what: `final reply in ${threadTs}` },
  );

describe.skipIf(!HAS_SERVICES)(
  'Phase 1 pipeline (Redis, Postgres, BullMQ, fake Slack)',
  { timeout: 30_000 },
  () => {
    const runner = new ScriptedRunner((req) => scriptFromPrompt(req.prompt));
    const h = new Harness({ runner });

    beforeAll(async () => {
      await h.start();
    });

    afterAll(async () => {
      await h.stop();
    });

    it('answers a mention in one placeholder that ends as the answer', async () => {
      const m = await h.mention('why does login flake?');
      expect(m.outcome).toBe('queued');
      expect(await finalReply(h, m.threadTs)).toEqual(['answer to: why does login flake?']);
      const placeholder = h.slack.botReplies('C0ENABLED1', m.threadTs)[0];
      expect(placeholder?.edits[0]).toBe(text.working);
      const run = await waitFor(async () =>
        (await h.runs()).find((r) => r.job_id === `evt-${m.eventId}` && r.posted),
      );
      expect(run).toMatchObject({ status: 'completed', outcome: 'completed', attempt: 1 });
    });

    it('keeps context across follow-ups in the thread', async () => {
      const first = await h.mention('what is a flaky test?');
      await finalReply(h, first.threadTs);
      await h.mention('and how do I fix one?', { threadTs: first.threadTs });
      const prompt = await waitFor(
        () => runner.started.find((s) => s.prompt.includes('how do I fix one'))?.prompt,
      );
      expect(prompt).toContain('what is a flaky test?');
      expect(prompt).toContain('"author": "Madar (you)"');
      expect(prompt).toContain('answer to: what is a flaky test?');
    });

    it('runs a thread strictly in order while other threads run alongside', async () => {
      const root = await h.mention('[delay=300] one');
      await h.mention('[delay=300] two', { threadTs: root.threadTs });
      await h.mention('[delay=300] three', { threadTs: root.threadTs });
      const other = await h.mention('[delay=300] elsewhere');
      await waitFor(
        () =>
          h.replies(root.threadTs).filter((r) => r.startsWith('answer')).length === 3
            ? true
            : undefined,
        {
          what: 'three answers',
        },
      );
      await finalReply(h, other.threadTs);

      const inThread = (label: string) => (s: { prompt: string }) =>
        lastMessageText(s.prompt).endsWith(label);
      const spans = ['one', 'two', 'three'].map((label) => ({
        start: runner.started.find(inThread(label))?.at ?? NaN,
        end: runner.finished.find(inThread(label))?.at ?? NaN,
      }));
      expect(spans[0]?.end).toBeLessThanOrEqual(spans[1]?.start ?? 0);
      expect(spans[1]?.end).toBeLessThanOrEqual(spans[2]?.start ?? 0);
      const elsewhere = runner.started.find(inThread('elsewhere'))?.at ?? NaN;
      expect(elsewhere).toBeLessThan(spans[0]?.end ?? 0);
      expect(h.replies(root.threadTs)).toEqual([
        'answer to: [delay=300] one',
        'answer to: [delay=300] two',
        'answer to: [delay=300] three',
      ]);
    });

    it('says "queued" when a request arrives behind another', async () => {
      const root = await h.mention('[delay=500] first');
      await h.mention('second', { threadTs: root.threadTs });
      const queued = h.slack.botReplies('C0ENABLED1', root.threadTs)[1];
      expect([queued?.text, ...(queued?.edits ?? [])]).toContain(text.queued);
      await waitFor(() =>
        h.replies(root.threadTs).every((r) => r.startsWith('answer')) ? true : undefined,
      );
    });

    it('handles a duplicate delivery of the same event once', async () => {
      const m = await h.mention('dedupe me');
      expect(await h.deliver(m.eventId, `<@U0BOT00001> dedupe me`, m.ts)).toBe('duplicate');
      await finalReply(h, m.threadTs);
      expect(h.replies(m.threadTs)).toHaveLength(1);
      expect(runner.started.filter((s) => s.prompt.includes('dedupe me'))).toHaveLength(1);
    });

    it('runs nothing in a channel that is not in the project map', async () => {
      const before = runner.started.length;
      const m = await h.mention('please run', { channel: OTHER_CHANNEL });
      expect(m.outcome).toBe('not_enabled');
      expect(h.replies(m.threadTs, OTHER_CHANNEL)).toEqual([text.notEnabled]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(runner.started.length).toBe(before);
    });

    it('stops the current run and cancels what is queued behind it', async () => {
      const root = await h.mention('[delay=20000] long job');
      const queued = await h.mention('queued job', { threadTs: root.threadTs });
      await waitFor(() => runner.started.find((s) => s.prompt.includes('long job')));
      const stop = await h.mention('stop', { threadTs: root.threadTs });
      expect(stop.outcome).toBe('stopped');
      await waitFor(() => {
        const r = h.replies(root.threadTs);
        return r.includes('Stopped by alice.') && r.includes(text.cancelledBeforeStart('alice'))
          ? r
          : undefined;
      });
      expect(h.replies(root.threadTs)).toEqual(
        ['Stopped by alice.', text.stopAck, text.cancelledBeforeStart('alice')].sort(
          (a, b) => order(a) - order(b),
        ),
      );
      expect(runner.started.some((s) => s.prompt.includes('queued job'))).toBe(false);
      const runs = await waitFor(async () => {
        const all = await h.runs();
        const mine = all.filter((r) =>
          [`evt-${root.eventId}`, `evt-${queued.eventId}`].includes(r.job_id),
        );
        return mine.length === 2 && mine.every((r) => r.posted) ? mine : undefined;
      });
      expect(runs.map((r) => [r.status, r.outcome])).toEqual([
        ['cancelled', 'cancelled'],
        ['cancelled', 'cancelled_before_start'],
      ]);

      function order(reply: string) {
        return h.replies(root.threadTs).indexOf(reply);
      }
    });

    it('answers help, empty mentions and stop with nothing running', async () => {
      const help = await h.mention('help');
      expect(help.outcome).toBe('help');
      expect(h.replies(help.threadTs)).toEqual([text.help]);
      const empty = await h.mention('');
      expect(empty.outcome).toBe('empty');
      const stop = await h.mention('stop');
      expect(stop.outcome).toBe('nothing_to_stop');
      expect(h.replies(stop.threadTs)).toEqual([text.nothingToStop]);
    });

    it('edits the placeholder with progress before the answer', async () => {
      const m = await h.mention('[delay=600] [progress] show progress');
      await finalReply(h, m.threadTs);
      const edits = h.slack.botReplies('C0ENABLED1', m.threadTs)[0]?.edits ?? [];
      expect(
        edits.some((e) => e.startsWith(PROGRESS_MARK) && e.includes('thinking about it')),
      ).toBe(true);
    });

    it('rate-limits a user per hour, without affecting other users', async () => {
      const deps = {
        ...h.mentionDeps,
        rateLimiter: new UserRateLimiter(h.redis, 2, `${h.prefix}:rl`),
        ratePerHour: 2,
      };
      const send = async (user: string, i: number) => {
        const message = h.slack.addUserMessage('C0ENABLED1', `<@U0BOT00001> burst ${String(i)}`, {
          user,
        });
        return handleMention(
          {
            eventId: `EvBurst${user}${String(i)}`,
            teamId: 'T0FAKE0001',
            channel: 'C0ENABLED1',
            user,
            botId: undefined,
            text: message.text,
            ts: message.ts,
            threadTs: undefined,
          },
          'U0BOT00001',
          deps,
        );
      };
      const outcomes = [];
      for (let i = 0; i < 4; i++) outcomes.push(await send('U0BURST001', i));
      expect(outcomes).toEqual(['queued', 'queued', 'rate_limited', 'rate_limited']);
      expect(await send('U0CALM0001', 0)).toBe('queued');
      const limited = h.slack.messages.filter((m) => m.text === text.rateLimited(2));
      expect(limited).toHaveLength(2);
    });
  },
);

describe.skipIf(!HAS_SERVICES)(
  'Phase 1 pipeline with the audit store down',
  { timeout: 30_000 },
  () => {
    const runner = new ScriptedRunner();
    const h = new Harness({ runner, runStoreDatabaseUrl: DEAD_DATABASE_URL });

    beforeAll(async () => {
      await h.start();
    });

    afterAll(async () => {
      await h.stop();
    });

    it('refuses the run, says why in the thread, and never calls the agent', async () => {
      const m = await h.mention('do something');
      expect(m.outcome).toBe('queued');
      expect(await finalReply(h, m.threadTs)).toEqual([text.auditUnavailable]);
      expect(runner.started).toHaveLength(0);
    });
  },
);
