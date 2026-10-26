import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROGRESS_MARK } from '../../src/agent/context.js';
import { ClaudeAgentRunner } from '../../src/agent/claude-runner.js';
import { FakeAnthropicApi } from '../fakes/anthropic-api.js';
import { Harness } from '../helpers/harness.js';
import { HAS_SERVICES, waitFor } from '../helpers/services.js';

/** Slack mention → gateway → queue → worker → real Agent SDK (fake API) → Slack answer. */
describe.skipIf(!HAS_SERVICES)('end to end with the real Agent SDK', { timeout: 60_000 }, () => {
  const api = new FakeAnthropicApi();
  let h: Harness;

  beforeAll(async () => {
    await api.start();
    const runner = new ClaudeAgentRunner({
      apiKey: 'sk-test-not-real',
      baseUrl: api.url,
      model: 'claude-sonnet-5-5',
      budgets: { maxTurns: 4, maxTokens: 50_000, maxCostUsd: 5, timeoutMs: 30_000 },
      apiMaxRetries: 0,
      workDir: undefined,
      logger: pino({ level: 'silent' }),
      inheritEnv: {},
    });
    h = await new Harness({ runner }).start();
  });

  afterAll(async () => {
    await h.stop();
    await api.stop();
  });

  it('answers through the real SDK, with the thread tagged by author', async () => {
    api.handler = (req) =>
      req.userText.includes('which browser')
        ? { kind: 'text', text: 'Use Chromium for that suite.', chunks: 3, chunkDelayMs: 20 }
        : { kind: 'text', text: 'ok' };
    const m = await h.mention('which browser should the smoke suite use?');
    const replies = await waitFor(
      () => {
        const r = h.replies(m.threadTs);
        return r.length === 1 && !r[0]?.startsWith(PROGRESS_MARK) ? r : undefined;
      },
      { timeoutMs: 30_000, what: 'answer' },
    );
    expect(replies).toEqual(['Use Chromium for that suite.']);
    const sent = api.requests.at(-1);
    expect(sent?.body['tools']).toEqual([]);
    expect(sent?.userText).toContain('"author": "@alice"');
    expect(sent?.userText).toContain('which browser should the smoke suite use?');
    expect(JSON.stringify(sent?.body['system'])).toContain('You are Madar');
    const run = await waitFor(async () => (await h.runs()).find((r) => r.posted));
    expect(run).toMatchObject({ status: 'completed', outcome: 'completed' });
  });

  it('escapes model output that tries to ping the channel', async () => {
    api.handler = () => ({ kind: 'text', text: '<!channel> everyone look at <@U0ADMIN001>' });
    const m = await h.mention('say something risky');
    const [reply] = await waitFor(
      () => {
        const r = h.replies(m.threadTs);
        return r.length === 1 && !r[0]?.startsWith(PROGRESS_MARK) ? r : undefined;
      },
      { timeoutMs: 30_000, what: 'answer' },
    );
    expect(reply).toBe('&lt;!channel&gt; everyone look at &lt;@U0ADMIN001&gt;');
  });
});
