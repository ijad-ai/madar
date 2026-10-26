import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  describeConfig,
  ENV_KEYS,
  loadConfig,
  maskUrlPassword,
  requireRole,
  type Role,
} from './env.js';

const valid = {
  REDIS_URL: 'redis://127.0.0.1:6379',
  DATABASE_URL: 'postgres://madar:s3cret-value@127.0.0.1:5432/madar',
};

const secrets = {
  SLACK_BOT_TOKEN: 'xoxb-bot-token-value',
  SLACK_APP_TOKEN: 'xapp-app-token-value',
  SLACK_SIGNING_SECRET: 'signing-secret-value-123',
  ANTHROPIC_API_KEY: 'sk-ant-api-key-value',
};

function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

const loadProblems = (env: Record<string, string | undefined>) => problemsOf(() => loadConfig(env));

describe('loadConfig', () => {
  it('applies defaults for optional variables', () => {
    const config = loadConfig(valid);
    expect(config).toEqual({
      nodeEnv: 'development',
      serviceName: 'madar',
      logLevel: 'info',
      redisUrl: valid.REDIS_URL,
      redisKeyPrefix: 'madar',
      databaseUrl: valid.DATABASE_URL,
      projectsFile: 'config/projects.json',
      slack: {
        transport: 'socket',
        botToken: undefined,
        appToken: undefined,
        signingSecret: undefined,
        httpPort: 3000,
        apiUrl: undefined,
      },
      agent: {
        apiKey: undefined,
        baseUrl: undefined,
        model: 'claude-sonnet-5-5',
        maxTurns: 8,
        maxTokens: 200_000,
        maxCostUsd: 2,
        timeoutSeconds: 300,
        apiMaxRetries: 3,
        workDir: undefined,
      },
      queue: { workerConcurrency: 4, globalConcurrency: undefined, ratePerUserPerHour: 30 },
    });
  });

  it('parses numbers and rejects out-of-range values', () => {
    const config = loadConfig({ ...valid, AGENT_MAX_TURNS: '12', AGENT_MAX_COST_USD: '0.5' });
    expect(config.agent.maxTurns).toBe(12);
    expect(config.agent.maxCostUsd).toBe(0.5);
    const problems = loadProblems({ ...valid, AGENT_MAX_TURNS: '0', WORKER_CONCURRENCY: '2.5' });
    expect(problems).toEqual([
      'AGENT_MAX_TURNS: must be at least 1',
      'WORKER_CONCURRENCY: must be a whole number',
    ]);
  });

  it('checks token prefixes without echoing the token', () => {
    const problems = loadProblems({ ...valid, SLACK_BOT_TOKEN: 'xoxp-user-token-value' });
    expect(problems).toEqual(['SLACK_BOT_TOKEN: must be a bot token (xoxb-…)']);
    expect(problems.join(' ')).not.toContain('user-token-value');
  });

  it('reads explicit values', () => {
    const config = loadConfig({
      ...valid,
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
      SERVICE_NAME: 'qa-bot',
    });
    expect(config.nodeEnv).toBe('test');
    expect(config.logLevel).toBe('debug');
    expect(config.serviceName).toBe('qa-bot');
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ ...valid, LOG_LEVEL: '', NODE_ENV: '   ' }).logLevel).toBe('info');
  });

  it('ignores unrelated environment variables', () => {
    const config = loadConfig({ ...valid, PATH: '/usr/bin', HOME: '/root' });
    expect(Object.keys(config)).not.toContain('PATH');
  });

  it('names every missing required variable', () => {
    expect(loadProblems({})).toEqual(['REDIS_URL: is required', 'DATABASE_URL: is required']);
  });

  it('rejects unknown log levels and malformed service names', () => {
    const problems = loadProblems({ ...valid, LOG_LEVEL: 'verbose', SERVICE_NAME: 'Bad Name' });
    expect(problems.some((p) => p.startsWith('LOG_LEVEL:'))).toBe(true);
    expect(problems.some((p) => p.startsWith('SERVICE_NAME:'))).toBe(true);
  });

  it('rejects the wrong URL schemes', () => {
    const problems = loadProblems({
      REDIS_URL: 'http://127.0.0.1:6379',
      DATABASE_URL: 'mysql://u:p@h/db',
    });
    expect(problems).toEqual([
      'REDIS_URL: must start with redis:// or rediss://',
      'DATABASE_URL: must start with postgres:// or postgresql://',
    ]);
  });

  it('never puts variable values in the error message', () => {
    const secret = 'hunter2-do-not-log';
    let message = '';
    try {
      loadConfig({ REDIS_URL: `http://:${secret}@h:1`, DATABASE_URL: `mysql://u:${secret}@h/db` });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(secret);
  });

  it('requires TLS to Redis and Postgres in production', () => {
    const problems = loadProblems({ ...valid, NODE_ENV: 'production' });
    expect(problems).toEqual([
      'REDIS_URL: must use rediss:// (TLS) in production',
      'DATABASE_URL: must set sslmode=require, verify-ca or verify-full in production',
    ]);
  });

  it('accepts a production config that uses TLS', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      REDIS_URL: 'rediss://redis.internal:6380',
      DATABASE_URL: 'postgres://madar:x@db.internal:5432/madar?sslmode=verify-full',
    });
    expect(config.nodeEnv).toBe('production');
  });

  it('returns a frozen object, including nested sections', () => {
    const config = loadConfig(valid);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.slack)).toBe(true);
    expect(Object.isFrozen(config.agent)).toBe(true);
  });
});

describe('requireRole', () => {
  const roleProblems = (role: Role, env: Record<string, string>) =>
    problemsOf(() => {
      requireRole(loadConfig({ ...valid, ...env }), role);
    });

  it('passes when each role has what it needs', () => {
    for (const role of ['gateway', 'worker', 'all', 'migrate'] as const) {
      expect(() => {
        requireRole(loadConfig({ ...valid, ...secrets }), role);
      }).not.toThrow();
    }
  });

  it('needs nothing extra for migrate', () => {
    expect(() => {
      requireRole(loadConfig(valid), 'migrate');
    }).not.toThrow();
  });

  it('lists everything the gateway is missing, per transport', () => {
    expect(roleProblems('gateway', {})).toEqual([
      'SLACK_BOT_TOKEN: is required',
      'SLACK_APP_TOKEN: is required when SLACK_TRANSPORT=socket',
    ]);
    expect(roleProblems('gateway', { SLACK_TRANSPORT: 'http' })).toEqual([
      'SLACK_BOT_TOKEN: is required',
      'SLACK_SIGNING_SECRET: is required when SLACK_TRANSPORT=http',
    ]);
  });

  it('requires the Slack bot token and Claude API key for the worker', () => {
    expect(roleProblems('worker', {})).toEqual([
      'SLACK_BOT_TOKEN: is required',
      'ANTHROPIC_API_KEY: is required',
    ]);
  });

  it('refuses a Slack API override in production', () => {
    const env = {
      ...secrets,
      NODE_ENV: 'production',
      REDIS_URL: 'rediss://redis.internal:6380',
      DATABASE_URL: 'postgres://madar:x@db.internal:5432/madar?sslmode=require',
      SLACK_API_URL: 'http://127.0.0.1:9999/api/',
    };
    expect(
      problemsOf(() => {
        requireRole(loadConfig(env), 'worker');
      }),
    ).toEqual(['SLACK_API_URL: must not be set in production']);
  });
});

describe('describeConfig', () => {
  it('masks passwords so the result is safe to log', () => {
    const described = describeConfig(loadConfig(valid));
    expect(described['databaseUrl']).toBe('postgres://madar:****@127.0.0.1:5432/madar');
    expect(JSON.stringify(described)).not.toContain('s3cret-value');
  });

  it('shows only whether secrets are set', () => {
    const json = JSON.stringify(describeConfig(loadConfig({ ...valid, ...secrets })));
    for (const value of Object.values(secrets)) expect(json).not.toContain(value);
    expect(json).toContain('"botToken":"set"');
    expect(json).toContain('"signingSecret":"set"');
  });

  it('leaves URLs without a password unchanged', () => {
    expect(maskUrlPassword('redis://127.0.0.1:6379')).toBe('redis://127.0.0.1:6379');
  });
});

describe('.env.example', () => {
  const example = parseEnv(readFileSync(new URL('../../.env.example', import.meta.url), 'utf8'));

  it('lists every variable the schema knows', () => {
    expect(Object.keys(example).sort()).toEqual([...ENV_KEYS].sort());
  });

  it('is a valid configuration as written', () => {
    expect(() => loadConfig(example)).not.toThrow();
  });
});
