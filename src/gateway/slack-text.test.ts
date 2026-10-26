import { describe, expect, it } from 'vitest';

import {
  escapeForSlack,
  MAX_SLACK_TEXT,
  parseMention,
  slackToPlainText,
  truncateForSlack,
} from './slack-text.js';

const BOT = 'U0BOT0001';

describe('parseMention', () => {
  it('strips the bot mention and returns the request', () => {
    expect(parseMention(`<@${BOT}> why did checkout fail?`, BOT)).toEqual({
      kind: 'request',
      text: 'why did checkout fail?',
    });
  });

  it('handles mentions anywhere, labelled mentions and extra whitespace', () => {
    expect(parseMention(`hey <@${BOT}|madar>   look at   this <@${BOT}>`, BOT)).toEqual({
      kind: 'request',
      text: 'hey look at this',
    });
  });

  it('keeps mentions of other people', () => {
    expect(parseMention(`<@${BOT}> ask <@U0OTHER01>`, BOT)).toEqual({
      kind: 'request',
      text: 'ask <@U0OTHER01>',
    });
  });

  it.each(['stop', 'STOP', 'cancel', 'stop.', 'Cancel!'])('treats "%s" as stop', (word) => {
    expect(parseMention(`<@${BOT}> ${word}`, BOT)).toEqual({ kind: 'stop' });
  });

  it('does not treat a sentence containing "stop" as a stop command', () => {
    expect(parseMention(`<@${BOT}> stop the flaky test from failing`, BOT).kind).toBe('request');
  });

  it('recognizes help and an empty mention', () => {
    expect(parseMention(`<@${BOT}> help`, BOT)).toEqual({ kind: 'help' });
    expect(parseMention(`<@${BOT}>   `, BOT)).toEqual({ kind: 'empty' });
  });
});

describe('escapeForSlack', () => {
  it.each([
    ['<!channel> deploy now', '&lt;!channel&gt; deploy now'],
    ['<!here>', '&lt;!here&gt;'],
    ['ping <@U0ADMIN01>', 'ping &lt;@U0ADMIN01&gt;'],
    ['<https://evil.example|click for docs>', '&lt;https://evil.example|click for docs&gt;'],
    ['a & b', 'a &amp; b'],
  ])('neutralizes %j', (input, expected) => {
    expect(escapeForSlack(input)).toBe(expected);
  });

  it('leaves ordinary text and plain URLs alone', () => {
    expect(escapeForSlack('See https://example.com/docs for *details*.')).toBe(
      'See https://example.com/docs for *details*.',
    );
  });
});

describe('truncateForSlack', () => {
  it('returns short text unchanged', () => {
    expect(truncateForSlack('short')).toBe('short');
  });

  it('cuts long text under the limit and says so', () => {
    const long = 'word '.repeat(5_000);
    const result = truncateForSlack(long);
    expect(result.length).toBeLessThanOrEqual(MAX_SLACK_TEXT);
    expect(result).toMatch(/_\(Answer cut at 12,000 characters\.\)_$/);
    expect(result).not.toMatch(/wor\n/);
  });
});

describe('slackToPlainText', () => {
  const names = { user: (id: string) => (id === 'U0ALICE01' ? 'alice' : id) };

  it('resolves user mentions and channel links', () => {
    expect(slackToPlainText('<@U0ALICE01> see <#C0123ABCD|qa-team>', names)).toBe(
      '@alice see #qa-team',
    );
  });

  it('unwraps links and broadcasts, and unescapes entities', () => {
    expect(
      slackToPlainText('<!here> <https://ci.example.test/run/1|run 1> &lt;b&gt; &amp;', names),
    ).toBe('@here run 1 (https://ci.example.test/run/1) <b> &');
  });

  it('unwraps bare links', () => {
    expect(slackToPlainText('<https://example.test/a>', names)).toBe('https://example.test/a');
  });
});
