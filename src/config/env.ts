import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

const redisUrl = z.url().refine((value) => /^rediss?:\/\//.test(value), {
  message: 'must start with redis:// or rediss://',
});

const postgresUrl = z.url().refine((value) => /^postgres(ql)?:\/\//.test(value), {
  message: 'must start with postgres:// or postgresql://',
});

const PROD_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

/**
 * Environment contract for the service. Each phase adds only the variables it needs.
 * Keep `.env.example` in sync: a test fails if a key is missing there.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS).default('development'),
    SERVICE_NAME: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes, max 63 chars')
      .default('madar'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    REDIS_URL: redisUrl,
    DATABASE_URL: postgresUrl,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // Fail closed: production traffic to Redis and Postgres must be encrypted.
    if (!env.REDIS_URL.startsWith('rediss://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'must use rediss:// (TLS) in production',
      });
    }
    const sslMode = new URL(env.DATABASE_URL).searchParams.get('sslmode');
    if (sslMode === null || !PROD_SSL_MODES.has(sslMode)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'must set sslmode=require, verify-ca or verify-full in production',
      });
    }
  });

export type EnvKey = keyof z.input<typeof envSchema>;
export const ENV_KEYS = Object.keys(envSchema.shape) as EnvKey[];

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly serviceName: string;
  readonly logLevel: LogLevel;
  readonly redisUrl: string;
  readonly databaseUrl: string;
}

/**
 * Thrown when the environment is invalid. The message names variables and rules only,
 * never their values, because values are often secrets.
 */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Treat empty strings as unset, so `LOG_LEVEL=` falls back to the default. */
function pickKnownKeys(env: Readonly<Record<string, string | undefined>>) {
  const picked: Partial<Record<EnvKey, string>> = {};
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') picked[key] = value.trim();
  }
  return picked;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env) {
  const result = envSchema.safeParse(pickKnownKeys(env));
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      const message = issue.code === 'invalid_type' ? 'is required' : issue.message;
      return `${name}: ${message}`;
    });
    throw new ConfigError(problems);
  }
  const parsed = result.data;
  const config: AppConfig = {
    nodeEnv: parsed.NODE_ENV,
    serviceName: parsed.SERVICE_NAME,
    logLevel: parsed.LOG_LEVEL,
    redisUrl: parsed.REDIS_URL,
    databaseUrl: parsed.DATABASE_URL,
  };
  return Object.freeze(config);
}

/** Replace any password in a URL with asterisks, for logs and diagnostics. */
export function maskUrlPassword(url: string): string {
  const parsed = new URL(url);
  if (parsed.password !== '') parsed.password = '****';
  return parsed.toString();
}

/** A copy of the config that is safe to log. */
export function describeConfig(config: AppConfig): Record<string, string> {
  return {
    nodeEnv: config.nodeEnv,
    serviceName: config.serviceName,
    logLevel: config.logLevel,
    redisUrl: maskUrlPassword(config.redisUrl),
    databaseUrl: maskUrlPassword(config.databaseUrl),
  };
}
