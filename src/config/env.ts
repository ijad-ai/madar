import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const SLACK_TRANSPORTS = ['socket', 'http'] as const;
export type SlackTransport = (typeof SLACK_TRANSPORTS)[number];

/** Which process is starting. Each role needs a different subset of the config. */
export const ROLES = ['gateway', 'worker', 'all', 'migrate'] as const;
export type Role = (typeof ROLES)[number];

const redisUrl = z.url().refine((value) => /^rediss?:\/\//.test(value), {
  message: 'must start with redis:// or rediss://',
});

const postgresUrl = z.url().refine((value) => /^postgres(ql)?:\/\//.test(value), {
  message: 'must start with postgres:// or postgresql://',
});

const httpUrl = z.url().refine((value) => /^https?:\/\//.test(value), {
  message: 'must start with http:// or https://',
});

function intIn(min: number, max: number) {
  return z.coerce
    .number()
    .int('must be a whole number')
    .min(min, `must be at least ${min}`)
    .max(max, `must be at most ${max}`);
}

const PROD_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

/**
 * Environment contract for the service. Each phase adds only the variables it needs.
 * Keep `.env.example` in sync: a test fails if a key is missing there.
 * Secrets are optional here; `requireRole` checks the ones a given process needs.
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
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'lowercase letters, digits, - and _, max 32 chars')
      .default('madar'),
    DATABASE_URL: postgresUrl,
    PROJECTS_FILE: z.string().min(1).default('config/projects.json'),

    SLACK_TRANSPORT: z.enum(SLACK_TRANSPORTS).default('socket'),
    SLACK_BOT_TOKEN: z.string().startsWith('xoxb-', 'must be a bot token (xoxb-…)').optional(),
    SLACK_APP_TOKEN: z
      .string()
      .startsWith('xapp-', 'must be an app-level token (xapp-…)')
      .optional(),
    SLACK_SIGNING_SECRET: z.string().min(16, 'is too short to be a signing secret').optional(),
    SLACK_HTTP_PORT: intIn(1, 65535).default(3000),
    SLACK_API_URL: httpUrl.optional(),

    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_BASE_URL: httpUrl.optional(),
    AGENT_MODEL: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,99}$/, 'must be a model id such as claude-sonnet-5-5')
      .default('claude-sonnet-5-5'),
    AGENT_MAX_TURNS: intIn(1, 100).default(8),
    AGENT_MAX_TOKENS: intIn(1_000, 10_000_000).default(200_000),
    AGENT_MAX_COST_USD: z.coerce.number().positive('must be above 0').max(100).default(2),
    AGENT_TIMEOUT_SECONDS: intIn(10, 3_600).default(300),
    AGENT_API_MAX_RETRIES: intIn(0, 10).default(3),
    AGENT_WORK_DIR: z.string().min(1).optional(),

    WORKER_CONCURRENCY: intIn(1, 64).default(4),
    GLOBAL_CONCURRENCY: intIn(1, 1_024).optional(),
    RATE_LIMIT_PER_USER_PER_HOUR: intIn(1, 10_000).default(30),
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

export interface SlackConfig {
  readonly transport: SlackTransport;
  readonly botToken: string | undefined;
  readonly appToken: string | undefined;
  readonly signingSecret: string | undefined;
  readonly httpPort: number;
  /** Override for the Slack Web API base URL. Only tests and fakes set this. */
  readonly apiUrl: string | undefined;
}

export interface AgentConfig {
  readonly apiKey: string | undefined;
  readonly baseUrl: string | undefined;
  readonly model: string;
  readonly maxTurns: number;
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  readonly timeoutSeconds: number;
  readonly apiMaxRetries: number;
  /** Parent directory for per-run working directories. Defaults to the OS temp dir. */
  readonly workDir: string | undefined;
}

export interface QueueConfig {
  readonly workerConcurrency: number;
  readonly globalConcurrency: number | undefined;
  readonly ratePerUserPerHour: number;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly serviceName: string;
  readonly logLevel: LogLevel;
  readonly redisUrl: string;
  /** Namespace for every Redis key, so environments can share a Redis safely. */
  readonly redisKeyPrefix: string;
  readonly databaseUrl: string;
  readonly projectsFile: string;
  readonly slack: SlackConfig;
  readonly agent: AgentConfig;
  readonly queue: QueueConfig;
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
  const picked = pickKnownKeys(env);
  const result = envSchema.safeParse(picked);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      const absent = picked[issue.path[0] as EnvKey] === undefined;
      const message = issue.code === 'invalid_type' && absent ? 'is required' : issue.message;
      return `${name}: ${message}`;
    });
    throw new ConfigError(problems);
  }
  const e = result.data;
  const config: AppConfig = {
    nodeEnv: e.NODE_ENV,
    serviceName: e.SERVICE_NAME,
    logLevel: e.LOG_LEVEL,
    redisUrl: e.REDIS_URL,
    redisKeyPrefix: e.REDIS_KEY_PREFIX,
    databaseUrl: e.DATABASE_URL,
    projectsFile: e.PROJECTS_FILE,
    slack: Object.freeze({
      transport: e.SLACK_TRANSPORT,
      botToken: e.SLACK_BOT_TOKEN,
      appToken: e.SLACK_APP_TOKEN,
      signingSecret: e.SLACK_SIGNING_SECRET,
      httpPort: e.SLACK_HTTP_PORT,
      apiUrl: e.SLACK_API_URL,
    }),
    agent: Object.freeze({
      apiKey: e.ANTHROPIC_API_KEY,
      baseUrl: e.ANTHROPIC_BASE_URL,
      model: e.AGENT_MODEL,
      maxTurns: e.AGENT_MAX_TURNS,
      maxTokens: e.AGENT_MAX_TOKENS,
      maxCostUsd: e.AGENT_MAX_COST_USD,
      timeoutSeconds: e.AGENT_TIMEOUT_SECONDS,
      apiMaxRetries: e.AGENT_API_MAX_RETRIES,
      workDir: e.AGENT_WORK_DIR,
    }),
    queue: Object.freeze({
      workerConcurrency: e.WORKER_CONCURRENCY,
      globalConcurrency: e.GLOBAL_CONCURRENCY,
      ratePerUserPerHour: e.RATE_LIMIT_PER_USER_PER_HOUR,
    }),
  };
  return Object.freeze(config);
}

/**
 * Check that the variables a given process needs are present. Fails closed with every
 * missing variable listed at once, so an operator fixes them in one pass.
 */
export function requireRole(config: AppConfig, role: Role): void {
  const missing: string[] = [];
  const needsGateway = role === 'gateway' || role === 'all';
  const needsWorker = role === 'worker' || role === 'all';
  if ((needsGateway || needsWorker) && config.slack.botToken === undefined) {
    missing.push('SLACK_BOT_TOKEN: is required');
  }
  if (needsGateway && config.slack.transport === 'socket' && config.slack.appToken === undefined) {
    missing.push('SLACK_APP_TOKEN: is required when SLACK_TRANSPORT=socket');
  }
  if (
    needsGateway &&
    config.slack.transport === 'http' &&
    config.slack.signingSecret === undefined
  ) {
    missing.push('SLACK_SIGNING_SECRET: is required when SLACK_TRANSPORT=http');
  }
  if (needsWorker && config.agent.apiKey === undefined) {
    missing.push('ANTHROPIC_API_KEY: is required');
  }
  if (config.nodeEnv === 'production' && config.slack.apiUrl !== undefined) {
    missing.push('SLACK_API_URL: must not be set in production');
  }
  if (missing.length > 0) throw new ConfigError(missing);
}

/** Replace any password in a URL with asterisks, for logs and diagnostics. */
export function maskUrlPassword(url: string): string {
  const parsed = new URL(url);
  if (parsed.password !== '') parsed.password = '****';
  return parsed.toString();
}

const presence = (value: string | undefined) => (value === undefined ? 'unset' : 'set');

/** A copy of the config that is safe to log: secrets show only whether they are set. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    serviceName: config.serviceName,
    logLevel: config.logLevel,
    redisUrl: maskUrlPassword(config.redisUrl),
    redisKeyPrefix: config.redisKeyPrefix,
    databaseUrl: maskUrlPassword(config.databaseUrl),
    projectsFile: config.projectsFile,
    slack: {
      transport: config.slack.transport,
      botToken: presence(config.slack.botToken),
      appToken: presence(config.slack.appToken),
      signingSecret: presence(config.slack.signingSecret),
      httpPort: config.slack.httpPort,
      apiUrl: config.slack.apiUrl ?? 'default',
    },
    agent: {
      apiKey: presence(config.agent.apiKey),
      baseUrl: config.agent.baseUrl ?? 'default',
      model: config.agent.model,
      maxTurns: config.agent.maxTurns,
      maxTokens: config.agent.maxTokens,
      maxCostUsd: config.agent.maxCostUsd,
      timeoutSeconds: config.agent.timeoutSeconds,
      apiMaxRetries: config.agent.apiMaxRetries,
    },
    queue: { ...config.queue },
  };
}
