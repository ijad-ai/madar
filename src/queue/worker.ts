import { Queue, QueueEvents, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { RUN_QUEUE, runJobSchema } from './jobs.js';
import type { RunProcessor } from './run-processor.js';

export interface RunWorkerOptions {
  /** A connection with `maxRetriesPerRequest: null`, as BullMQ workers require. */
  readonly connection: Redis;
  readonly prefix: string;
  readonly concurrency: number;
  readonly globalConcurrency: number | undefined;
  /** How long a job lock lasts; a worker that dies loses its jobs after this. */
  readonly lockDurationMs?: number;
  readonly stalledIntervalMs?: number;
}

export interface RunWorker {
  readonly worker: Worker;
  close(): Promise<void>;
}

export function createRunQueue(connection: Redis, prefix: string): Queue {
  return new Queue(RUN_QUEUE, { connection, prefix });
}

/**
 * Starts consuming runs. A job whose worker dies is picked up again by BullMQ's stalled
 * check; the run processor decides from the audit record whether to restart it (D-004).
 * maxStalledCount is above the processor's own limit so the processor, not BullMQ, makes
 * that call. If BullMQ does give up, the `failed` listener closes the run out cleanly.
 */
export async function startRunWorker(
  processor: RunProcessor,
  queue: Queue,
  options: RunWorkerOptions,
  logger: Logger,
): Promise<RunWorker> {
  if (options.globalConcurrency !== undefined) {
    await queue.setGlobalConcurrency(options.globalConcurrency);
  }
  const worker = new Worker(
    RUN_QUEUE,
    async (job, token) => {
      await processor.process(job, token);
    },
    {
      connection: options.connection,
      prefix: options.prefix,
      concurrency: options.concurrency,
      lockDuration: options.lockDurationMs ?? 30_000,
      stalledInterval: options.stalledIntervalMs ?? 30_000,
      maxStalledCount: 3,
    },
  );
  worker.on('error', (error) => {
    logger.error({ err: error }, 'queue worker error');
  });
  worker.on('stalled', (jobId) => {
    logger.warn({ jobId }, 'job stalled; it will be picked up again');
  });

  const events = new QueueEvents(RUN_QUEUE, {
    connection: options.connection.duplicate(),
    prefix: options.prefix,
  });
  events.on('failed', ({ jobId, failedReason }) => {
    void (async () => {
      logger.warn({ jobId, failedReason }, 'job failed in the queue; closing its run');
      const job = await queue.getJob(jobId);
      const parsed = runJobSchema.safeParse(job?.data);
      if (parsed.success) await processor.reconcileFailed(jobId, parsed.data);
    })().catch((error: unknown) => {
      logger.error({ err: error, jobId }, 'could not handle a failed job');
    });
  });
  await worker.waitUntilReady();
  await events.waitUntilReady();

  return {
    worker,
    close: async () => {
      await worker.close();
      await events.close();
    },
  };
}
