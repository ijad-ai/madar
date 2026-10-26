/**
 * The environment for the Agent SDK's subprocess. The SDK replaces the subprocess
 * environment with exactly this object, so nothing else from the worker leaks in:
 * not the Slack token, not the database URL, not future connector tokens (threat T21).
 */
export interface SdkEnvInput {
  readonly apiKey: string;
  readonly baseUrl: string | undefined;
  /** Per-run directories, so no user or host settings are read (threat T10). */
  readonly home: string;
  readonly configDir: string;
  readonly maxRetries: number;
  readonly clientApp: string;
  /** Where to copy network and locale settings from. Usually process.env. */
  readonly inherit: Readonly<Record<string, string | undefined>>;
}

/** Network and locale settings the subprocess may need. Nothing secret belongs here. */
export const INHERITED_VARS = [
  'PATH',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'TZ',
  'LANG',
] as const;

export function buildSdkEnv(input: SdkEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_VARS) {
    const value = input.inherit[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  env['PATH'] ??= '/usr/local/bin:/usr/bin:/bin';
  Object.assign(env, {
    HOME: input.home,
    CLAUDE_CONFIG_DIR: input.configDir,
    ANTHROPIC_API_KEY: input.apiKey,
    // No telemetry, error reporting or update checks: the only network call is the model.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    // The SDK retries failed API calls 10 times by default, over more than a minute.
    CLAUDE_CODE_MAX_RETRIES: String(input.maxRetries),
    CLAUDE_AGENT_SDK_CLIENT_APP: input.clientApp,
  });
  if (input.baseUrl !== undefined) env['ANTHROPIC_BASE_URL'] = input.baseUrl;
  return env;
}
