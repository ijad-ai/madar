import type { RunUsage } from '../audit/run-store.js';

/**
 * How a run ended. Budget and timeout outcomes are not errors: the run stopped where it
 * was told to, and the thread says which limit it hit.
 */
export const AGENT_OUTCOMES = [
  'completed',
  'budget_turns',
  'budget_tokens',
  'budget_cost',
  'timeout',
  'cancelled',
  'model_api_error',
  'unexpected_tools',
  'error',
] as const;
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number];

export type AgentProgress =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'retrying'; readonly attempt: number; readonly maxRetries: number };

export interface AgentRequest {
  readonly runId: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  /** Aborted when someone sends `stop` in the thread. */
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: AgentProgress) => void;
}

export interface AgentResult {
  readonly outcome: AgentOutcome;
  /** The answer, or whatever text was produced before the run stopped. */
  readonly text: string;
  readonly usage: RunUsage;
  readonly model: string;
  readonly toolCalls: number;
  /** The tool list the SDK reported at startup. Must equal the tools we registered. */
  readonly reportedTools: readonly string[];
  /** Non-content details for the audit log and the thread, such as the limit that was hit. */
  readonly detail: Readonly<Record<string, string | number>>;
}

export interface Budgets {
  readonly maxTurns: number;
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  readonly timeoutMs: number;
}

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>;
}

export const EMPTY_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  turns: 0,
};

export function totalTokens(usage: RunUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}
