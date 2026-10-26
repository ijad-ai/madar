import type { AgentResult } from '../agent/runner.js';
import { PROGRESS_MARK } from '../agent/context.js';
import { escapeForSlack, truncateForSlack } from './slack-text.js';

/**
 * Every message the bot writes to Slack, in one place so the wording can be reviewed.
 * Text from the model always goes through `escapeForSlack`. Our own wording may use Slack
 * markup. Final messages never start with PROGRESS_MARK: a message that still starts with
 * it is, by definition, unfinished (see the worker's reconcile step).
 */

const PROGRESS_TAIL_CHARS = 2_500;
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

export const text = {
  notEnabled:
    "I'm not enabled in this channel yet. An admin can add it to the project map (`config/projects.json`).",
  rateLimited: (limit: number) =>
    `You've reached the limit of ${limit} requests per hour. Please try again a little later.`,
  help: [
    'Mention me with a question and I’ll answer in this thread. I read the thread for context.',
    'Say `stop` to cancel what I’m doing here, and anything queued behind it.',
    'This version has no tools yet: I can’t open links, read repositories or check CI.',
  ].join('\n'),
  empty: 'Ask me something after the mention, or say `help`.',
  stopAck: 'Stopping the current request and anything queued in this thread.',
  nothingToStop: 'There’s nothing running or queued in this thread.',
  queueUnavailable:
    "I can't take requests right now because my queue is unavailable. Please try again shortly.",

  queued: `${PROGRESS_MARK} Queued behind the current request in this thread.`,
  working: `${PROGRESS_MARK} Working on it…`,
  restarted: `${PROGRESS_MARK} Restarted after an interruption. Working on it…`,
  retrying: (attempt: number, max: number) =>
    `${PROGRESS_MARK} The Claude API is busy. Retrying (attempt ${attempt} of ${max})…`,
  progress: (elapsedSeconds: number, partial: string) => {
    const head = `${PROGRESS_MARK} Working on it… (${elapsedSeconds}s)`;
    if (partial.trim() === '') return head;
    const tail =
      partial.length > PROGRESS_TAIL_CHARS ? `…${partial.slice(-PROGRESS_TAIL_CHARS)}` : partial;
    return `${head}\n\n${escapeForSlack(tail)}`;
  },

  auditUnavailable:
    "I can't take this request: the audit log is unavailable, and I don't act without it. Nothing was done. Please try again later.",
  auditLostAfterRun: (ref: string) =>
    `The audit log became unavailable before I could record this request, so I've withheld the answer. Reference: \`${ref}\``,
  cancelledBeforeStart: (by: string) => `Cancelled by ${by} before it started.`,
  interrupted: (ref: string) =>
    `This request was interrupted twice, so I stopped it. Nothing else was done. Mention me again to retry. Reference: \`${ref}\``,
  lostBeforePosting: (ref: string) =>
    `This request finished, but its answer was lost before it reached Slack. Mention me again to retry. Reference: \`${ref}\``,
  failed: (ref: string) =>
    `Something went wrong and I couldn't finish this request. Reference: \`${ref}\``,
} as const;

/** The final message for a finished agent run. */
export function finalText(result: AgentResult, ref: string, stoppedBy?: string): string {
  const partial = result.text.trim();
  const soFar = partial === '' ? '' : `\n\nHere's what I had so far:\n${escapeForSlack(partial)}`;
  const limit = result.detail['limit'];
  let body: string;
  switch (result.outcome) {
    case 'completed':
      body = partial === '' ? '_(No answer was produced.)_' : escapeForSlack(partial);
      break;
    case 'budget_tokens':
      body = `Stopped: this request reached its limit of ${String(limit)} tokens.${soFar}`;
      break;
    case 'budget_turns':
      body = `Stopped: this request reached its limit of ${String(limit)} steps.${soFar}`;
      break;
    case 'budget_cost':
      body = `Stopped: this request reached its cost limit of $${String(limit)}.${soFar}`;
      break;
    case 'timeout':
      body = `Stopped: this request ran longer than ${String(result.detail['limitSeconds'])} seconds.${soFar}`;
      break;
    case 'cancelled':
      body = `Stopped by ${stoppedBy ?? 'request'}.${soFar}`;
      break;
    case 'model_api_error': {
      const status = result.detail['apiStatus'];
      const suffix = status === undefined ? '' : ` (status ${String(status)})`;
      body = `I couldn't get an answer from the Claude API${suffix}. Nothing else was done. Reference: \`${ref}\``;
      break;
    }
    case 'unexpected_tools':
      body = `I stopped before answering because the agent reported tools I don't allow. This has been logged. Reference: \`${ref}\``;
      break;
    case 'error':
      body = text.failed(ref);
      break;
  }
  const safe = truncateForSlack(body);
  // Never let a final message look unfinished.
  return safe.startsWith(PROGRESS_MARK) ? `${ZERO_WIDTH_SPACE}${safe}` : safe;
}
