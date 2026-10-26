import {
  EMPTY_USAGE,
  type AgentOutcome,
  type AgentRequest,
  type AgentResult,
  type AgentRunner,
} from '../../src/agent/runner.js';

export interface Script {
  readonly delayMs?: number;
  readonly text?: string;
  readonly outcome?: AgentOutcome;
  /** Stream this text as progress before answering. */
  readonly progress?: string;
}

/**
 * A stand-in for the Claude runner in queue tests: deterministic timing, observable
 * concurrency, and cancellation that behaves like the real one.
 */
export class ScriptedRunner implements AgentRunner {
  readonly started: { prompt: string; at: number }[] = [];
  readonly finished: { prompt: string; at: number; outcome: AgentOutcome }[] = [];
  active = 0;
  maxActive = 0;

  constructor(private readonly script: (request: AgentRequest) => Script = () => ({})) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const plan = this.script(request);
    this.started.push({ prompt: request.prompt, at: Date.now() });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (plan.progress !== undefined) request.onProgress?.({ kind: 'text', text: plan.progress });
      const cancelled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(false);
        }, plan.delayMs ?? 0);
        request.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true },
        );
      });
      const outcome: AgentOutcome = cancelled ? 'cancelled' : (plan.outcome ?? 'completed');
      this.finished.push({ prompt: request.prompt, at: Date.now(), outcome });
      return {
        outcome,
        text: cancelled ? (plan.progress ?? '') : (plan.text ?? 'scripted answer'),
        usage: { ...EMPTY_USAGE, inputTokens: 10, outputTokens: 5, turns: 1 },
        model: 'scripted',
        toolCalls: 0,
        reportedTools: [],
        detail: {},
      };
    } finally {
      this.active -= 1;
    }
  }
}

/** The text of the last thread message in a prompt built by buildPrompt. */
export function lastMessageText(prompt: string): string {
  const start = prompt.indexOf('[');
  const end = prompt.lastIndexOf(']');
  const thread = JSON.parse(prompt.slice(start, end + 1)) as { text: string }[];
  return thread.at(-1)?.text ?? '';
}
