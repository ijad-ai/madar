import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeSlackApi } from '../../test/fakes/slack-api.js';
import { createWebClient, WebClientSlackApi } from './slack-api.js';

const slack = new FakeSlackApi();
let api: WebClientSlackApi;

beforeAll(async () => {
  await slack.start();
  api = new WebClientSlackApi(
    createWebClient({
      token: 'xoxb-test',
      apiUrl: slack.url,
      logger: pino({ level: 'silent' }),
      retries: 0,
    }),
  );
});

afterAll(async () => {
  await slack.stop();
});

describe('WebClientSlackApi against the fake Slack API', () => {
  it('posts in a thread with parsing and unfurls off, then updates', async () => {
    const root = slack.addUserMessage('C0TEST0001', 'hello');
    const ts = await api.postInThread('C0TEST0001', root.ts, 'Working…');
    await api.update('C0TEST0001', ts, 'Done.');
    const [post] = slack.callsTo('chat.postMessage');
    expect(post?.args).toMatchObject({ parse: 'none', link_names: 'false', unfurl_links: 'false' });
    expect(slack.botReplies('C0TEST0001', root.ts).map((m) => m.text)).toEqual(['Done.']);
  });

  it('reads a thread up to a message and caps the count', async () => {
    const root = slack.addUserMessage('C0TEST0002', 'first');
    const second = slack.addUserMessage('C0TEST0002', 'second', { threadTs: root.ts });
    slack.addUserMessage('C0TEST0002', 'after', { threadTs: root.ts });
    const all = await api.threadMessages('C0TEST0002', root.ts, { latest: second.ts, limit: 50 });
    expect(all.map((m) => m.text)).toEqual(['first', 'second']);
    const capped = await api.threadMessages('C0TEST0002', root.ts, { latest: second.ts, limit: 1 });
    expect(capped.map((m) => m.text)).toEqual(['second']);
  });

  it('resolves user names, caches them, and falls back to the id', async () => {
    expect(await api.userName('U0ALICE001')).toBe('alice');
    expect(await api.userName('U0ALICE001')).toBe('alice');
    expect(slack.callsTo('users.info')).toHaveLength(1);
    expect(await api.userName('U0UNKNOWN1')).toBe('U0UNKNOWN1');
  });

  it('treats an existing reaction as success', async () => {
    const root = slack.addUserMessage('C0TEST0003', 'hi');
    await api.addReaction('C0TEST0003', root.ts, 'eyes');
    await expect(api.addReaction('C0TEST0003', root.ts, 'eyes')).resolves.toBeUndefined();
  });

  it('surfaces other Slack errors', async () => {
    slack.failNext('chat.update', 'cant_update_message');
    await expect(api.update('C0TEST0003', '1.000001', 'x')).rejects.toThrow(/cant_update_message/);
  });
});
