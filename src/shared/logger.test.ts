import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { getCorrelationId, normalizeCorrelationId, withCorrelationId } from './correlation.js';
import { createLogger } from './logger.js';

function capture() {
  const raw: string[] = [];
  const stream = {
    write(line: string) {
      raw.push(line);
    },
  };
  const logger = createLogger({ level: 'info', serviceName: 'madar-test' }, stream);
  const lines = () => raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, raw, lines };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('createLogger', () => {
  it('writes structured JSON with service, level label and ISO time', () => {
    const { logger, lines } = capture();
    logger.info({ step: 'boot' }, 'started');
    const [line] = lines();
    expect(line).toMatchObject({
      service: 'madar-test',
      level: 'info',
      step: 'boot',
      msg: 'started',
    });
    expect(typeof line?.['time']).toBe('string');
  });

  it('adds the correlation id inside a request and omits it outside', () => {
    const { logger, lines } = capture();
    withCorrelationId('Ev012ABC', () => {
      logger.info('inside');
    });
    logger.info('outside');
    const [inside, outside] = lines();
    expect(inside?.['correlationId']).toBe('Ev012ABC');
    expect(outside).not.toHaveProperty('correlationId');
  });

  it('keeps concurrent requests apart across awaits', async () => {
    const { logger, lines } = capture();
    const run = (id: string, delays: number[]) =>
      withCorrelationId(id, async () => {
        for (const delay of delays) {
          await sleep(delay);
          logger.info({ expected: id }, 'tick');
        }
      });
    await Promise.all([run('C1:111.1', [5, 1, 5]), run('C2:222.2', [1, 5, 1])]);
    const ticks = lines();
    expect(ticks).toHaveLength(6);
    for (const tick of ticks) expect(tick['correlationId']).toBe(tick['expected']);
  });

  it('redacts credentials by key, wherever they sit', () => {
    const { logger, raw, lines } = capture();
    logger.info(
      {
        password: 'pw-1',
        token: 'tok-1',
        headers: { authorization: 'Bearer abc-1', cookie: 'sid=xyz-1', 'set-cookie': 'sid=xyz-2' },
        connector: { apiKey: 'key-1', accessToken: 'at-1' },
        config: { databaseUrl: 'postgres://u:dbpw-1@h/db' },
      },
      'request',
    );
    const [line] = lines();
    expect(line?.['password']).toBe('[REDACTED]');
    expect(line?.['headers']).toEqual({
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'set-cookie': '[REDACTED]',
    });
    for (const secret of ['pw-1', 'tok-1', 'abc-1', 'xyz-1', 'xyz-2', 'key-1', 'at-1', 'dbpw-1']) {
      expect(raw.join('')).not.toContain(secret);
    }
  });

  it('respects the configured level', () => {
    const raw: string[] = [];
    const logger = createLogger(
      { level: 'warn', serviceName: 'madar-test' },
      { write: (line: string) => raw.push(line) },
    );
    logger.info('hidden');
    logger.warn('shown');
    expect(raw).toHaveLength(1);
  });
});

describe('correlation ids', () => {
  it('accepts Slack-style and thread-style ids', () => {
    expect(normalizeCorrelationId('Ev0123ABCD')).toBe('Ev0123ABCD');
    expect(normalizeCorrelationId('C0123:1729850000.123456')).toBe('C0123:1729850000.123456');
  });

  it('replaces ids that could inject log content', () => {
    const injected = 'abc\n{"level":"fatal","msg":"fake"}';
    expect(normalizeCorrelationId(injected)).toMatch(UUID);
    expect(normalizeCorrelationId('x'.repeat(129))).toMatch(UUID);
    expect(normalizeCorrelationId(undefined)).toMatch(UUID);
    expect(normalizeCorrelationId(42)).toMatch(UUID);
  });

  it('generates an id when none is given', () => {
    const id = withCorrelationId(undefined, () => getCorrelationId());
    expect(id).toMatch(UUID);
    expect(getCorrelationId()).toBeUndefined();
  });
});
