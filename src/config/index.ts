import { existsSync } from 'node:fs';

import { loadConfig, type AppConfig } from './env.js';

export * from './env.js';

/**
 * Load `.env` (if present) into process.env, then validate. Variables already set in the
 * environment win over the file, so deployments never depend on a file on disk.
 */
export function loadConfigFromProcess(envFile = '.env'): AppConfig {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return loadConfig(process.env);
}
