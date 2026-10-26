import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { App } from '@slack/bolt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSlackApp } from '../../src/gateway/app.js';
import type { MentionOutcome } from '../../src/gateway/mention-handler.js';
import type { RunJobData } from '../../src/queue/jobs.js';
import { ScriptedRunner } from '../fakes/scripted-runner.js';
import { FAKE_BOT_USER, FAKE_TEAM } from '../fakes/slack-api.js';
import { CHANNEL, Harness, OTHER_CHANNEL } from '../helpers/harness.js';
import { HAS_SERVICES, waitFor } from '../helpers/services.js';

const SIGNING_SECRET = 'test-signing-secret-0123456789';
const SLOW_ENQUEUE_MS = 4_000;

/**
 * The gateway over real HTTP: Bolt's receiver, signature checks and ack behaviour, with
 * signed fake Slack payloads.
 */
describe.skipIf(!HAS_SERVICES)('gateway over HTTP (Bolt)', { timeout: 30_000 }, () => {
  const h = new Harness({ runner: new ScriptedRunner(), startWorker: false });
  const outcomes: MentionOutcome[] = [];
  const enqueued: RunJobData[] = [];
  let app: App;
  let url: string;
  let seq = 0;

  beforeAll(async () => {
    await h.start();
    const realProducer = h.mentionDeps.producer;
    // Enqueueing takes 4 seconds here, longer than Slack's 3-second ack window.
    const slowProducer = {
      enqueue: async (data: RunJobData) => {
        await new Promise((resolve) => setTimeout(resolve, SLOW_ENQUEUE_MS));
        enqueued.push(data);
        return realProducer.enqueue(data);
      },
    };
    ({ app } = createSlackApp({
      slack: {
        transport: 'http',
        botToken: 'xoxb-test',
        appToken: undefined,
        signingSecret: SIGNING_SECRET,
        httpPort: 0,
        apiUrl: h.slack.url,
      },
      deps: { ...h.mentionDeps, producer: slowProducer },
      logger: h.logger,
      onHandled: (outcome) => outcomes.push(outcome),
    }));
    const server = (await app.start(0)) as Server;
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/slack/events`;
  });

  afterAll(async () => {
    await app.stop();
    await h.stop();
  });

  function mentionPayload(channel: string, words: string) {
    seq += 1;
    const message = h.slack.addUserMessage(channel, `<@${FAKE_BOT_USER}> ${words}`);
    return {
      token: 'legacy-token-unused',
      team_id: FAKE_TEAM,
      api_app_id: 'A0FAKEAPP1',
      type: 'event_callback',
      event_id: `EvHttp${h.prefix.slice(-6)}${String(seq)}`,
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [{ team_id: FAKE_TEAM, user_id: FAKE_BOT_USER, is_bot: true }],
      event: {
        type: 'app_mention',
        user: 'U0ALICE001',
        text: message.text,
        ts: message.ts,
        channel,
        event_ts: message.ts,
      },
    };
  }

  async function post(
    body: unknown,
    opts: { secret?: string; timestamp?: number; headers?: Record<string, string> } = {},
  ) {
    const raw = JSON.stringify(body);
    const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', opts.secret ?? SIGNING_SECRET)
      .update(`v0:${timestamp}:${raw}`)
      .digest('hex')}`;
    const started = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
        ...opts.headers,
      },
      body: raw,
    });
    return { status: response.status, body: await response.text(), ms: Date.now() - started };
  }

  it('answers the URL verification challenge', async () => {
    const res = await post({ type: 'url_verification', token: 'x', challenge: 'challenge-123' });
    expect(res.status).toBe(200);
    expect(res.body).toContain('challenge-123');
  });

  it('acks a mention well inside 3 seconds even when handling takes longer', async () => {
    const payload = mentionPayload(CHANNEL, 'slow path');
    const res = await post(payload);
    expect(res.status).toBe(200);
    expect(res.ms).toBeLessThan(1_000);
    await waitFor(() => enqueued.find((d) => d.eventId === payload.event_id), {
      timeoutMs: SLOW_ENQUEUE_MS + 5_000,
      what: 'slow enqueue to finish',
    });
  });

  it('rejects a bad signature and a stale timestamp, and handles neither', async () => {
    const before = outcomes.length;
    expect(
      (await post(mentionPayload(CHANNEL, 'forged'), { secret: 'wrong-secret-000000' })).status,
    ).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    expect((await post(mentionPayload(CHANNEL, 'replayed'), { timestamp: stale })).status).toBe(
      401,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(outcomes.length).toBe(before);
  });

  it('processes a Slack retry of the same event once', async () => {
    const payload = mentionPayload(CHANNEL, 'retried');
    expect((await post(payload)).status).toBe(200);
    const retry = await post(payload, {
      headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' },
    });
    expect(retry.status).toBe(200);
    await waitFor(() => (outcomes.includes('duplicate') ? true : undefined), {
      what: 'duplicate outcome',
    });
    await waitFor(() => enqueued.find((d) => d.eventId === payload.event_id), {
      timeoutMs: SLOW_ENQUEUE_MS + 5_000,
    });
    expect(enqueued.filter((d) => d.eventId === payload.event_id)).toHaveLength(1);
  });

  it('replies and runs nothing in a channel outside the project map', async () => {
    const payload = mentionPayload(OTHER_CHANNEL, 'not here');
    expect((await post(payload)).status).toBe(200);
    await waitFor(() => (outcomes.includes('not_enabled') ? true : undefined), {
      what: 'not_enabled outcome',
    });
    expect(enqueued.find((d) => d.eventId === payload.event_id)).toBeUndefined();
  });
});
