import { describe, expect, it } from 'vitest';

import { loadProjectMap, parseProjectMap, ProjectMapError } from './projects.js';

const project = { id: 'checkout', name: 'Checkout', slackChannels: ['C0123ABCD45'] };

function problems(json: unknown): string {
  try {
    parseProjectMap(json);
  } catch (error) {
    if (error instanceof ProjectMapError) return error.message;
    throw error;
  }
  throw new Error('expected ProjectMapError');
}

describe('project map', () => {
  it('finds the project for a mapped channel and nothing for others', () => {
    const map = parseProjectMap({
      projects: [project, { id: 'search', name: 'Search', slackChannels: ['G0999ZZZZ99'] }],
    });
    expect(map.projectForChannel('C0123ABCD45')?.id).toBe('checkout');
    expect(map.projectForChannel('G0999ZZZZ99')?.id).toBe('search');
    expect(map.projectForChannel('C0000NOPE00')).toBeUndefined();
    expect(map.channelCount).toBe(2);
  });

  it('accepts an empty map: the bot then answers nowhere', () => {
    expect(parseProjectMap({ projects: [] }).channelCount).toBe(0);
  });

  it('rejects a channel mapped to two projects', () => {
    const message = problems({ projects: [project, { ...project, id: 'other' }] });
    expect(message).toContain('channel C0123ABCD45 is already mapped to project "checkout"');
  });

  it('rejects duplicate project ids', () => {
    const message = problems({
      projects: [project, { ...project, slackChannels: ['C0999ZZZZ99'] }],
    });
    expect(message).toContain('duplicate project id "checkout"');
  });

  it('rejects unknown keys, so a typo fails instead of being ignored', () => {
    expect(problems({ projects: [{ ...project, slackChanels: ['C1'] }] })).toContain(
      'slackChanels',
    );
  });

  it('rejects malformed channel ids', () => {
    const message = problems({ projects: [{ ...project, slackChannels: ['#qa-team'] }] });
    expect(message).toContain('must be a Slack channel id');
  });

  it('loads the committed config/projects.json', () => {
    expect(() => loadProjectMap('config/projects.json')).not.toThrow();
  });

  it('reports a missing or unreadable file clearly', () => {
    expect(() => loadProjectMap('config/does-not-exist.json')).toThrow(/could not read JSON/);
  });
});
