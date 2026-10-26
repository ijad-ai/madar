import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import type { LogLevel } from '../config/env.js';
import { getCorrelationId } from './correlation.js';

/**
 * Key-based backstop: values under these keys never reach a log line.
 * Content redaction (secrets inside free text, CI logs, traces) is src/redaction/ (Phase 3).
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["set-cookie"]',
  'databaseUrl',
  '*.databaseUrl',
  'redisUrl',
  '*.redisUrl',
];

export interface LoggerSettings {
  readonly level: LogLevel;
  readonly serviceName: string;
}

export function createLogger(settings: LoggerSettings, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: settings.level,
    base: { service: settings.serviceName },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    mixin() {
      const correlationId = getCorrelationId();
      return correlationId === undefined ? {} : { correlationId };
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
