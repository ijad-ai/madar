import { DelayedError, type Job, type Queue } from 'bullmq';
import type { Logger } from 'pino';

import { buildPrompt, PROGRESS_MARK } from '../agent/context.js';
import type { AgentResult, AgentRunner } from '../agent/runner.js';
import type { RunRecord, RunStore, TerminalStatus } from '../audit/run-store.js';
import { finalText, text } from '../gateway/messages.js';
import type { SlackApi } from '../gateway/slack-api.js';
import { withCorrelationId } from '../shared/correlation.js';
import { runJobSchema, runKeyOf, threadOf, type RunJobData } from './jobs.js';
import { ProgressUpdater } from './progress.js';
import { isStopped, type ThreadRef, type ThreadScheduler } from './thread-scheduler.js';

export interface RunProcessorSettings {
  readonly model: string;
  readonly promptVersion: string;
  readonly systemPrompt: string;
  /** Thread lock lease; renewed while the run is active. */
  readonly lockTtlMs: number;
  readonly lockRenewMs: number;
  /** How often a running job checks for `stop`. */
  readonly stopPollMs: number;
  readonly progressEveryMs: number;
  readonly heartbeatMs: number;
  /** How long a job that can't run yet waits before trying again. */
  readonly retryDelayMs: number;
  /** D-004: a run that dies is restarted at most once (attempt 2), then marked interrupted. */
  readonly maxAttempts: number;
  readonly historyLimit: number;
}

export const DEFAULT_SETTINGS: Omit<
  RunProcessorSettings,
  'model' | 'promptVersion' | 'systemPrompt'
> = {
  lockTtlMs: 30_000,
  lockRenewMs: 10_000,
  stopPollMs: 1_000,
  progressEveryMs: 3_000,
  heartbeatMs: 15_000,
  retryDelayMs: 750,
  maxAttempts: 2,
  historyLimit: 60,
};

export interface RunProcessorDeps {
  readonly scheduler: ThreadScheduler;
  /** Used to tell live jobs from stale pending entries. */
  readonly queue: Pick<Queue, 'getJobState'>;
  readonly store: RunStore;
  readonly slack: SlackApi;
  readonly runner: AgentRunner;
  readonly bot: { readonly userId: string; readonly botId: string | undefined };
  readonly logger: Logger;
  readonly settings: RunProcessorSettings;
}

const LIVE_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

function statusFor(result: AgentResult): TerminalStatus {
  if (result.outcome === 'completed') return 'completed';
  if (result.outcome === 'cancelled') return 'cancelled';
  return 'failed';
}

/**
 * Processes one queued request. The rules it keeps:
 *
 * - Order: a job runs only when it is first in its thread and holds the thread lock.
 * - Fail closed: no run without an audit record; no answer posted without recording it.
 * - One outcome: the worker only edits the request's single placeholder message, so a
 *   restart or a duplicate delivery can never post a second answer.
 */
export class RunProcessor {
  constructor(private readonly deps: RunProcessorDeps) {}

  async process(job: Job, token: string | undefined): Promise<void> {
    const data = runJobSchema.parse(job.data);
    const jobId = job.id ?? '';
    await withCorrelationId(data.eventId, async () => {
      const thread = threadOf(data);
      const slot = await this.acquireSlot(thread, jobId, data);
      if (!slot) {
        await job.moveToDelayed(Date.now() + this.deps.settings.retryDelayMs, token);
        throw new DelayedError();
      }
      try {
        await this.runAcquired(jobId, data, thread);
      } finally {
        await this.deps.scheduler.release(thread, jobId);
      }
    });
  }

  /** Called when BullMQ gives up on a job (it stalled too many times). */
  async reconcileFailed(jobId: string, data: RunJobData): Promise<void> {
    const log = this.deps.logger.child({ jobId });
    const placeholder = data.placeholderTs;
    try {
      const run = await this.deps.store.getByJobId(jobId);
      if (run?.status === 'running') {
        await this.deps.store.finish(run.id, { status: 'interrupted', outcome: 'stalled' });
      }
      const ts = run?.placeholderTs ?? placeholder;
      if (ts !== undefined && run?.postedAt == null) {
        await this.deps.slack.update(data.channelId, ts, text.interrupted(run?.id ?? jobId));
        if (run !== undefined) await this.deps.store.markPosted(run.id);
      }
    } catch (error) {
      log.error({ err: error }, 'could not reconcile a failed job');
    } finally {
      await this.deps.scheduler.release(threadOf(data), jobId);
    }
  }

  private async acquireSlot(thread: ThreadRef, jobId: string, data: RunJobData): Promise<boolean> {
    const { scheduler, queue, settings } = this.deps;
    for (let i = 0; i < 5; i++) {
      const result = await scheduler.acquire(thread, jobId, settings.lockTtlMs);
      if (result.kind === 'acquired') return true;
      if (result.kind === 'not_registered') {
        await scheduler.register(thread, jobId, data.messageTs);
        continue;
      }
      if (result.kind === 'waiting') {
        const state = await queue.getJobState(result.headJobId);
        if (!LIVE_STATES.has(state)) {
          await scheduler.removeStale(thread, result.headJobId);
          continue;
        }
      }
      return false;
    }
    return false;
  }

  private async runAcquired(jobId: string, data: RunJobData, thread: ThreadRef): Promise<void> {
    const { store, scheduler, settings } = this.deps;
    const log = this.deps.logger.child({ jobId, channel: data.channelId, thread: data.threadTs });

    let begun;
    try {
      begun = await store.begin(runKeyOf(jobId, data), {
        model: settings.model,
        promptVersion: settings.promptVersion,
        correlationId: data.eventId,
      });
    } catch (error) {
      log.error({ err: error }, 'audit store unavailable; refusing the run');
      await this.writeFinal(data, data.placeholderTs, text.auditUnavailable);
      return;
    }
    const { run, state } = begun;

    if (state === 'finished') {
      await this.reconcileFinished(run, data);
      return;
    }

    const stop = await scheduler.stopRequest(thread);
    if (isStopped(stop, data.messageTs)) {
      const by = await this.deps.slack.userName(stop.by);
      await this.finishWithoutRun(
        run,
        data,
        'cancelled',
        'cancelled_before_start',
        text.cancelledBeforeStart(by),
        stop.by,
      );
      return;
    }

    if (state === 'restarted' && (run.attempt > settings.maxAttempts || run.toolCalls > 0)) {
      log.warn({ attempt: run.attempt }, 'run interrupted too often; not restarting');
      await this.finishWithoutRun(
        run,
        data,
        'interrupted',
        'interrupted',
        text.interrupted(run.id),
      );
      return;
    }

    try {
      await this.execute(run, data, thread, state === 'restarted', log);
    } catch (error) {
      log.error({ err: error }, 'run failed unexpectedly');
      await this.finishWithoutRun(run, data, 'failed', 'error', text.failed(run.id));
    }
  }

  private async execute(
    run: RunRecord,
    data: RunJobData,
    thread: ThreadRef,
    restarted: boolean,
    log: Logger,
  ): Promise<void> {
    const { slack, store, scheduler, runner, settings } = this.deps;
    const startedAt = Date.now();

    const placeholderTs = await this.ensurePlaceholder(run, data, restarted);

    const messages = await slack.threadMessages(data.channelId, data.threadTs, {
      latest: data.messageTs,
      limit: settings.historyLimit,
    });
    const ids = [...new Set(messages.map((m) => m.userId).filter((id) => id !== undefined))];
    const names = new Map(
      await Promise.all(ids.map(async (id) => [id, await slack.userName(id)] as const)),
    );
    const prompt = buildPrompt({
      messages,
      requestTs: data.messageTs,
      botUserId: this.deps.bot.userId,
      botId: this.deps.bot.botId,
      names,
    });

    const cancel = new AbortController();
    let stoppedBy: string | undefined;
    let partial = '';
    const progress = new ProgressUpdater(
      slack,
      data.channelId,
      placeholderTs,
      settings.progressEveryMs,
      log,
    );
    const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
    const timers = [
      setInterval(() => {
        void scheduler.renew(thread, run.jobId, settings.lockTtlMs).catch(() => undefined);
      }, settings.lockRenewMs),
      setInterval(() => {
        void scheduler
          .stopRequest(thread)
          .then((stop) => {
            if (isStopped(stop, data.messageTs) && !cancel.signal.aborted) {
              stoppedBy = stop.by;
              cancel.abort();
            }
          })
          .catch(() => undefined);
      }, settings.stopPollMs),
      setInterval(() => {
        progress.set(text.progress(elapsed(), partial));
      }, settings.heartbeatMs),
    ];

    let result: AgentResult;
    try {
      result = await runner.run({
        runId: run.id,
        systemPrompt: settings.systemPrompt,
        prompt,
        signal: cancel.signal,
        onProgress: (p) => {
          if (p.kind === 'text') {
            partial = p.text;
            progress.set(text.progress(elapsed(), partial));
          } else {
            progress.set(text.retrying(p.attempt, p.maxRetries));
          }
        },
      });
    } finally {
      for (const timer of timers) clearInterval(timer);
      await progress.stop();
    }

    const stopperName = stoppedBy === undefined ? undefined : await slack.userName(stoppedBy);
    try {
      await store.finish(run.id, {
        status: statusFor(result),
        outcome: result.outcome,
        model: result.model,
        usage: result.usage,
        actor: stoppedBy,
        details: {
          ...result.detail,
          toolCalls: result.toolCalls,
          durationMs: Date.now() - startedAt,
        },
      });
    } catch (error) {
      log.error({ err: error }, 'audit store unavailable after the run; withholding the answer');
      await this.writeFinal(data, placeholderTs, text.auditLostAfterRun(run.id));
      return;
    }

    await slack.update(data.channelId, placeholderTs, finalText(result, run.id, stopperName));
    await store.markPosted(run.id).catch((error: unknown) => {
      log.warn({ err: error }, 'answer posted but not marked; reconcile will settle it');
    });
    log.info({ outcome: result.outcome, usage: result.usage }, 'run finished');
  }

  /** The placeholder this run edits: from the gateway, from a previous attempt, or new. */
  private async ensurePlaceholder(
    run: RunRecord,
    data: RunJobData,
    restarted: boolean,
  ): Promise<string> {
    const { slack, store } = this.deps;
    const status = restarted ? text.restarted : text.working;
    const existing = run.placeholderTs ?? data.placeholderTs;
    if (existing !== undefined) {
      if (run.placeholderTs !== existing) await store.setPlaceholder(run.id, existing);
      await slack.update(data.channelId, existing, status).catch(() => undefined);
      return existing;
    }
    const ts = await slack.postInThread(data.channelId, data.threadTs, status);
    await store.setPlaceholder(run.id, ts);
    return ts;
  }

  /**
   * A run that is already finished was delivered again. If its answer never reached
   * Slack (the placeholder still shows progress), say so instead of leaving it hanging.
   */
  private async reconcileFinished(run: RunRecord, data: RunJobData): Promise<void> {
    if (run.postedAt !== null || run.placeholderTs === null) return;
    const [message] = await this.deps.slack.threadMessages(data.channelId, data.threadTs, {
      latest: run.placeholderTs,
      limit: 1,
    });
    if (message?.ts === run.placeholderTs && message.text.startsWith(PROGRESS_MARK)) {
      await this.deps.slack.update(
        data.channelId,
        run.placeholderTs,
        text.lostBeforePosting(run.id),
      );
    }
    await this.deps.store.markPosted(run.id);
  }

  private async finishWithoutRun(
    run: RunRecord,
    data: RunJobData,
    status: TerminalStatus,
    outcome: string,
    message: string,
    actor?: string,
  ): Promise<void> {
    try {
      await this.deps.store.finish(run.id, { status, outcome, actor });
    } catch (error) {
      this.deps.logger.error({ err: error, runId: run.id }, 'could not record the run outcome');
      await this.writeFinal(data, run.placeholderTs ?? data.placeholderTs, text.auditUnavailable);
      return;
    }
    await this.writeFinal(data, run.placeholderTs ?? data.placeholderTs, message);
    await this.deps.store.markPosted(run.id).catch(() => undefined);
  }

  /** Write a final message into the placeholder, or as a new reply if there is none. */
  private async writeFinal(
    data: RunJobData,
    placeholderTs: string | null | undefined,
    message: string,
  ) {
    try {
      if (placeholderTs !== undefined && placeholderTs !== null) {
        await this.deps.slack.update(data.channelId, placeholderTs, message);
      } else {
        await this.deps.slack.postInThread(data.channelId, data.threadTs, message);
      }
    } catch (error) {
      this.deps.logger.error({ err: error }, 'could not write the final message to Slack');
    }
  }
}
