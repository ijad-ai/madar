import { describe, expect, it } from 'vitest';

import { PROGRESS_MARK } from '../agent/context.js';
import { EMPTY_USAGE, type AgentResult } from '../agent/runner.js';
import { finalText, text } from './messages.js';

function result(overrides: Partial<AgentResult>): AgentResult {
  return {
    outcome: 'completed',
    text: '',
    usage: EMPTY_USAGE,
    model: 'claude-sonnet-5-5',
    toolCalls: 0,
    reportedTools: [],
    detail: {},
    ...overrides,
  };
}

describe('finalText', () => {
  it('escapes model output so it cannot ping or mention anyone', () => {
    const out = finalText(result({ text: '<!channel> ask <@U0ADMIN01>' }), 'run-1');
    expect(out).toBe('&lt;!channel&gt; ask &lt;@U0ADMIN01&gt;');
  });

  it.each([
    ['budget_tokens', { limit: 1000 }, 'limit of 1000 tokens'],
    ['budget_turns', { limit: 8 }, 'limit of 8 steps'],
    ['budget_cost', { limit: 2 }, 'cost limit of $2'],
    ['timeout', { limitSeconds: 300 }, 'longer than 300 seconds'],
    ['model_api_error', { apiStatus: 401 }, 'Claude API (status 401)'],
  ] as const)('explains %s', (outcome, detail, phrase) => {
    expect(finalText(result({ outcome, detail }), 'run-1')).toContain(phrase);
  });

  it('includes partial text, escaped, when a limit stopped the run', () => {
    const out = finalText(
      result({ outcome: 'timeout', text: 'half <b>', detail: { limitSeconds: 5 } }),
      'r',
    );
    expect(out).toContain("Here's what I had so far:\nhalf &lt;b&gt;");
  });

  it('names who stopped a cancelled run', () => {
    expect(finalText(result({ outcome: 'cancelled' }), 'r', 'alice')).toBe('Stopped by alice.');
  });

  it('gives a reference, never internals, for errors', () => {
    expect(finalText(result({ outcome: 'error', text: 'stack trace…' }), 'run-42')).toBe(
      "Something went wrong and I couldn't finish this request. Reference: `run-42`",
    );
  });

  it('never returns text that looks unfinished', () => {
    const out = finalText(result({ text: `${PROGRESS_MARK} sneaky` }), 'r');
    expect(out.startsWith(PROGRESS_MARK)).toBe(false);
  });

  it('marks every progress message as unfinished', () => {
    for (const t of [
      text.queued,
      text.working,
      text.restarted,
      text.retrying(1, 3),
      text.progress(3, 'x'),
    ]) {
      expect(t.startsWith(PROGRESS_MARK)).toBe(true);
    }
  });

  it('escapes partial text in progress updates and keeps only the tail', () => {
    const update = text.progress(12, `${'a'.repeat(3_000)}<!here>`);
    expect(update).toContain('(12s)');
    expect(update).toContain('&lt;!here&gt;');
    expect(update.length).toBeLessThan(2_700);
  });
});
