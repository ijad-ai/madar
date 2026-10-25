import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ConfigError, describeConfig, ENV_KEYS, loadConfig, maskUrlPassword } from './env.js';

const valid = {
  REDIS_URL: 'redis://127.0.0.1:6379',
  DATABASE_URL: 'postgres://madar:s3cret-value@127.0.0.1:5432/madar',
};

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies defaults for optional variables', () => {
    const config = loadConfig(valid);
    expect(config).toEqual({
      nodeEnv: 'development',
      serviceName: 'madar',
      logLevel: 'info',
      redisUrl: valid.REDIS_URL,
      databaseUrl: valid.DATABASE_URL,
    });
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
    expect(problemsOf({})).toEqual(['REDIS_URL: is required', 'DATABASE_URL: is required']);
  });

  it('rejects unknown log levels and malformed service names', () => {
    const problems = problemsOf({ ...valid, LOG_LEVEL: 'verbose', SERVICE_NAME: 'Bad Name' });
    expect(problems.some((p) => p.startsWith('LOG_LEVEL:'))).toBe(true);
    expect(problems.some((p) => p.startsWith('SERVICE_NAME:'))).toBe(true);
  });

  it('rejects the wrong URL schemes', () => {
    const problems = problemsOf({
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
    const problems = problemsOf({ ...valid, NODE_ENV: 'production' });
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

  it('returns a frozen object', () => {
    expect(Object.isFrozen(loadConfig(valid))).toBe(true);
  });
});

describe('describeConfig', () => {
  it('masks passwords so the result is safe to log', () => {
    const described = describeConfig(loadConfig(valid));
    expect(described['databaseUrl']).toBe('postgres://madar:****@127.0.0.1:5432/madar');
    expect(JSON.stringify(described)).not.toContain('s3cret-value');
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
