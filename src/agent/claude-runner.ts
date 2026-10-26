import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from 'pino';

import type { RunUsage } from '../audit/run-store.js';
import {
  EMPTY_USAGE,
  totalTokens,
  type AgentOutcome,
  type AgentRequest,
  type AgentResult,
  type AgentRunner,
  type Budgets,
} from './runner.js';
import { buildSdkEnv } from './sdk-env.js';

export interface ClaudeRunnerOptions {
  readonly apiKey: string;
  readonly baseUrl: string | undefined;
  readonly model: string;
  readonly budgets: Budgets;
  readonly apiMaxRetries: number;
  /** Parent of the per-run directories. Defaults to the OS temp dir. */
  readonly workDir: string | undefined;
  readonly logger: Logger;
  /** Where network settings are inherited from. Tests pass `{}`. */
  readonly inheritEnv?: Readonly<Record<string, string | undefined>>;
  /** Tool names we register. Phase 1 registers none. */
  readonly allowedTools?: readonly string[];
  /**
   * Test seam: runs after the per-run directories exist and before the SDK starts, so a
   * test can plant settings files and prove they have no effect (threat T10).
   */
  readonly prepareRunDirs?: (dirs: RunDirs) => Promise<void>;
}

export interface RunDirs {
  readonly cwd: string;
  readonly home: string;
  readonly configDir: string;
}

const CLIENT_APP = 'madar/0.1.0';

/**
 * Runs one request through the Claude Agent SDK, locked down per decision D-001:
 * built-in tools off, no settings files, an empty per-run working directory, and a
 * subprocess environment that holds only the API key and network settings.
 */
export class ClaudeAgentRunner implements AgentRunner {
  constructor(private readonly options: ClaudeRunnerOptions) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const { budgets, logger } = this.options;
    const allowedTools = this.options.allowedTools ?? [];
    const root = await mkdtemp(join(this.options.workDir ?? tmpdir(), `madar-run-`));
    const cwd = join(root, 'cwd');
    const home = join(root, 'home');
    const configDir = join(root, 'config');
    await Promise.all([mkdir(cwd), mkdir(home), mkdir(configDir)]);
    await this.options.prepareRunDirs?.({ cwd, home, configDir });

    const controller = new AbortController();
    let stopReason: AgentOutcome | undefined;
    const stop = (reason: AgentOutcome) => {
      if (stopReason !== undefined) return;
      stopReason = reason;
      controller.abort();
    };
    const onCancel = () => {
      stop('cancelled');
    };
    if (request.signal.aborted) stop('cancelled');
    request.signal.addEventListener('abort', onCancel, { once: true });
    const timer = setTimeout(() => {
      stop('timeout');
    }, budgets.timeoutMs);

    const tracker = new UsageTracker();
    let partial = '';
    let finalText: string | undefined;
    let toolCalls = 0;
    let reportedTools: readonly string[] = [];
    let result: Extract<SDKMessage, { type: 'result' }> | undefined;
    const detail: Record<string, string | number> = {};

    const sdkOptions: Options = {
      cwd,
      model: this.options.model,
      systemPrompt: request.systemPrompt,
      tools: [],
      allowedTools: [...allowedTools],
      disallowedTools: [],
      permissionMode: 'dontAsk',
      settingSources: [],
      mcpServers: {},
      maxTurns: budgets.maxTurns,
      maxBudgetUsd: budgets.maxCostUsd,
      persistSession: false,
      includePartialMessages: true,
      abortController: controller,
      env: buildSdkEnv({
        apiKey: this.options.apiKey,
        baseUrl: this.options.baseUrl,
        home,
        configDir,
        maxRetries: this.options.apiMaxRetries,
        clientApp: CLIENT_APP,
        inherit: this.options.inheritEnv ?? process.env,
      }),
      stderr: (data: string) => {
        logger.debug(
          { runId: request.runId, stderr: data.slice(0, 2_000) },
          'agent subprocess stderr',
        );
      },
    };

    try {
      for await (const message of query({ prompt: request.prompt, options: sdkOptions })) {
        switch (message.type) {
          case 'system':
            if (message.subtype === 'init') {
              reportedTools = [...message.tools];
              const unexpected = message.tools.filter((t) => !allowedTools.includes(t));
              if (unexpected.length > 0 || message.mcp_servers.length > 0) {
                // Fail closed if the SDK ever enables something we did not register.
                detail['unexpectedTools'] = [
                  ...unexpected,
                  ...message.mcp_servers.map((s) => `mcp:${s.name}`),
                ].join(', ');
                stop('unexpected_tools');
              }
            } else if (message.subtype === 'api_retry') {
              request.onProgress?.({
                kind: 'retrying',
                attempt: message.attempt,
                maxRetries: message.max_retries,
              });
            }
            break;
          case 'stream_event': {
            const event = message.event;
            if (event.type === 'message_start') {
              tracker.startMessage(event.message.usage);
            } else if (event.type === 'message_delta') {
              tracker.updateOutput(event.usage.output_tokens);
            } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              partial += event.delta.text;
              request.onProgress?.({ kind: 'text', text: partial });
            }
            if (totalTokens(tracker.current()) > budgets.maxTokens) stop('budget_tokens');
            break;
          }
          case 'assistant': {
            const text = message.message.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('');
            if (text !== '') partial = text;
            toolCalls += message.message.content.filter(
              (block) => block.type === 'tool_use',
            ).length;
            break;
          }
          case 'result':
            result = message;
            if (message.subtype === 'success') finalText = message.result;
            break;
          default:
            break;
        }
        if (stopReason !== undefined) break;
      }
    } catch (error) {
      if (stopReason === undefined && result === undefined) {
        logger.warn({ runId: request.runId, err: error }, 'agent run threw');
      }
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onCancel);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }

    const usage = result === undefined ? tracker.current() : usageFromResult(result);
    const outcome = stopReason ?? outcomeFromResult(result, detail);
    if (outcome === 'budget_tokens') detail['limit'] = budgets.maxTokens;
    if (outcome === 'budget_turns') detail['limit'] = budgets.maxTurns;
    if (outcome === 'budget_cost') detail['limit'] = budgets.maxCostUsd;
    if (outcome === 'timeout') detail['limitSeconds'] = Math.round(budgets.timeoutMs / 1000);
    return {
      outcome,
      text: outcome === 'completed' ? (finalText ?? partial) : partial,
      usage,
      model: this.options.model,
      toolCalls,
      reportedTools,
      detail,
    };
  }
}

function outcomeFromResult(
  result: Extract<SDKMessage, { type: 'result' }> | undefined,
  detail: Record<string, string | number>,
): AgentOutcome {
  if (result === undefined) return 'error';
  switch (result.subtype) {
    case 'success':
      if (!result.is_error) return 'completed';
      if (typeof result.api_error_status === 'number') {
        detail['apiStatus'] = result.api_error_status;
        return 'model_api_error';
      }
      return 'error';
    case 'error_max_turns':
      return 'budget_turns';
    case 'error_max_budget_usd':
      return 'budget_cost';
    default:
      return 'error';
  }
}

function usageFromResult(result: Extract<SDKMessage, { type: 'result' }>): RunUsage {
  return {
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    cacheReadTokens: result.usage.cache_read_input_tokens,
    cacheCreationTokens: result.usage.cache_creation_input_tokens,
    costUsd: result.total_cost_usd,
    turns: result.num_turns,
  };
}

interface StreamUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
}

/** Running token count from the stream, so the token budget can stop a run mid-answer. */
class UsageTracker {
  private done: RunUsage = EMPTY_USAGE;
  private live: RunUsage = EMPTY_USAGE;

  startMessage(usage: StreamUsage): void {
    this.done = add(this.done, this.live);
    this.live = {
      ...EMPTY_USAGE,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    };
  }

  updateOutput(outputTokens: number): void {
    this.live = { ...this.live, outputTokens };
  }

  current(): RunUsage {
    return add(this.done, this.live);
  }
}

function add(a: RunUsage, b: RunUsage): RunUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd + b.costUsd,
    turns: a.turns + b.turns,
  };
}
