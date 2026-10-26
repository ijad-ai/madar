import { describe, expect, it } from 'vitest';

import { buildSdkEnv } from './sdk-env.js';

const workerEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/worker',
  HTTPS_PROXY: 'http://proxy.internal:3128',
  NO_PROXY: '127.0.0.1',
  SLACK_BOT_TOKEN: 'xoxb-secret',
  SLACK_APP_TOKEN: 'xapp-secret',
  DATABASE_URL: 'postgres://u:dbsecret@db/madar',
  REDIS_URL: 'redis://:redissecret@redis:6379',
  GITHUB_TOKEN: 'ghp_secret',
  ANTHROPIC_API_KEY: 'sk-from-worker-env',
  CLAUDE_CONFIG_DIR: '/home/worker/.claude',
};

const input = {
  apiKey: 'sk-ant-run-key',
  baseUrl: undefined,
  home: '/tmp/run-1/home',
  configDir: '/tmp/run-1/config',
  maxRetries: 3,
  clientApp: 'madar/0.1.0',
  inherit: workerEnv,
};

describe('buildSdkEnv', () => {
  it('passes only network settings and the run-specific values', () => {
    expect(buildSdkEnv(input)).toEqual({
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'http://proxy.internal:3128',
      NO_PROXY: '127.0.0.1',
      HOME: '/tmp/run-1/home',
      CLAUDE_CONFIG_DIR: '/tmp/run-1/config',
      ANTHROPIC_API_KEY: 'sk-ant-run-key',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_MAX_RETRIES: '3',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'madar/0.1.0',
    });
  });

  it('never carries Slack, database, Redis or connector secrets', () => {
    const serialized = JSON.stringify(buildSdkEnv(input));
    for (const secret of ['xoxb-secret', 'xapp-secret', 'dbsecret', 'redissecret', 'ghp_secret']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("uses the run's home and config dirs, never the worker's", () => {
    const env = buildSdkEnv(input);
    expect(env['HOME']).toBe('/tmp/run-1/home');
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/tmp/run-1/config');
  });

  it('sets the base URL only when configured, and has a PATH fallback', () => {
    const env = buildSdkEnv({ ...input, baseUrl: 'http://127.0.0.1:9', inherit: {} });
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:9');
    expect(env['PATH']).toBe('/usr/local/bin:/usr/bin:/bin');
  });
});
