import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeAnthropicApi } from '../../test/fakes/anthropic-api.js';
import { ClaudeAgentRunner, type ClaudeRunnerOptions, type RunDirs } from './claude-runner.js';
import type { AgentProgress, AgentRequest } from './runner.js';

/**
 * These tests run the real Claude Agent SDK and its subprocess against a local fake of
 * the Messages API: no network, no API key, and the real option handling.
 */
const api = new FakeAnthropicApi();

beforeAll(async () => {
  await api.start();
});

afterAll(async () => {
  await api.stop();
});

beforeEach(() => {
  api.requests.length = 0;
  api.handler = () => ({ kind: 'text', text: 'Hello from the fake API.' });
});

function runner(overrides: Partial<ClaudeRunnerOptions> = {}) {
  return new ClaudeAgentRunner({
    apiKey: 'sk-test-not-real',
    baseUrl: api.url,
    model: 'claude-sonnet-5-5',
    budgets: { maxTurns: 4, maxTokens: 50_000, maxCostUsd: 5, timeoutMs: 30_000 },
    apiMaxRetries: 0,
    workDir: undefined,
    logger: pino({ level: 'silent' }),
    inheritEnv: {},
    ...overrides,
  });
}

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    runId: 'run-test',
    systemPrompt: 'You are MADAR-TEST-SYSTEM-PROMPT.',
    prompt: 'MADAR-TEST-USER-PROMPT: say hello',
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('ClaudeAgentRunner (real SDK, fake API)', { timeout: 30_000 }, () => {
  it('runs with no built-in tools: the SDK reports none and sends none to the API', async () => {
    const result = await runner().run(request());
    expect(result.outcome).toBe('completed');
    expect(result.reportedTools).toEqual([]);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.body['tools']).toEqual([]);
  });

  it('returns the answer, usage and turn count', async () => {
    api.handler = () => ({
      kind: 'text',
      text: 'Login flakes because SSO times out.',
      inputTokens: 120,
      outputTokens: 9,
    });
    const result = await runner().run(request());
    expect(result).toMatchObject({
      outcome: 'completed',
      text: 'Login flakes because SSO times out.',
      model: 'claude-sonnet-5-5',
      toolCalls: 0,
    });
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 9, turns: 1 });
  });

  it('sends our system prompt and the thread prompt, nothing from the host', async () => {
    await runner().run(request());
    const body = JSON.stringify(api.requests[0]?.body);
    expect(body).toContain('MADAR-TEST-SYSTEM-PROMPT');
    expect(api.requests[0]?.userText).toContain('MADAR-TEST-USER-PROMPT');
  });

  it('ignores settings, hooks and CLAUDE.md planted in every place the SDK looks (T10)', async () => {
    const markers: string[] = [];
    const plant = async (dirs: RunDirs) => {
      const hookSettings = (marker: string) =>
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }] },
          permissions: { allow: ['Bash(*)'] },
        });
      for (const [dir, settingsDir] of [
        [dirs.cwd, join(dirs.cwd, '.claude')],
        [dirs.home, join(dirs.home, '.claude')],
        [dirs.configDir, dirs.configDir],
      ] as const) {
        const marker = join(dir, 'HOOK_RAN');
        markers.push(marker);
        await mkdir(settingsDir, { recursive: true });
        await writeFile(join(settingsDir, 'settings.json'), hookSettings(marker));
        await writeFile(join(dir, 'CLAUDE.md'), 'PLANTED-INSTRUCTION-DO-NOT-LOAD');
        await writeFile(join(settingsDir, 'CLAUDE.md'), 'PLANTED-INSTRUCTION-DO-NOT-LOAD');
      }
    };
    const observed: boolean[] = [];
    const result = await runner({
      prepareRunDirs: async (dirs) => {
        await plant(dirs);
      },
    }).run(
      request({
        onProgress: () => {
          observed.push(markers.some((m) => existsSync(m)));
        },
      }),
    );
    expect(result.outcome).toBe('completed');
    expect(result.reportedTools).toEqual([]);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((ran) => !ran)).toBe(true);
    expect(JSON.stringify(api.requests[0]?.body)).not.toContain('PLANTED-INSTRUCTION');
  });

  it('streams progress text as it arrives', async () => {
    api.handler = () => ({
      kind: 'text',
      text: 'one two three four five',
      chunks: 5,
      chunkDelayMs: 30,
    });
    const progress: AgentProgress[] = [];
    const result = await runner().run(request({ onProgress: (p) => progress.push(p) }));
    const texts = progress.filter((p) => p.kind === 'text').map((p) => p.text);
    expect(texts.length).toBeGreaterThanOrEqual(5);
    expect(texts.at(-1)).toBe('one two three four five');
    expect(result.text).toBe('one two three four five');
  });

  it('stops at the token budget and keeps the partial text', async () => {
    api.handler = () => ({ kind: 'text', text: 'a very long answer', outputTokens: 900_000 });
    const result = await runner({
      budgets: { maxTurns: 4, maxTokens: 1_000, maxCostUsd: 5, timeoutMs: 30_000 },
    }).run(request());
    expect(result.outcome).toBe('budget_tokens');
    expect(result.detail['limit']).toBe(1_000);
  });

  it('stops at the wall-clock budget', async () => {
    api.handler = () => ({ kind: 'hang' });
    const started = Date.now();
    const result = await runner({
      budgets: { maxTurns: 4, maxTokens: 50_000, maxCostUsd: 5, timeoutMs: 1_000 },
    }).run(request());
    expect(result.outcome).toBe('timeout');
    expect(result.detail['limitSeconds']).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops when the run is cancelled', async () => {
    api.handler = () => ({ kind: 'hang' });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 500);
    const result = await runner().run(request({ signal: controller.signal }));
    expect(result.outcome).toBe('cancelled');
  });

  it('reports an API error quickly, with its status, when retries are off', async () => {
    api.handler = () => ({
      kind: 'error',
      status: 401,
      type: 'authentication_error',
      message: 'invalid x-api-key',
    });
    const started = Date.now();
    const result = await runner().run(request());
    expect(result.outcome).toBe('model_api_error');
    expect(result.detail['apiStatus']).toBe(401);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports API retries as progress', async () => {
    let calls = 0;
    api.handler = () => {
      calls += 1;
      return calls === 1
        ? { kind: 'error', status: 529, type: 'overloaded_error', message: 'Overloaded' }
        : { kind: 'text', text: 'recovered' };
    };
    const progress: AgentProgress[] = [];
    const result = await runner({ apiMaxRetries: 1 }).run(
      request({ onProgress: (p) => progress.push(p) }),
    );
    expect(result.outcome).toBe('completed');
    expect(progress.some((p) => p.kind === 'retrying' && p.attempt === 1)).toBe(true);
  });
});
