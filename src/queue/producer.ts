import type { Queue } from 'bullmq';

import { jobIdFor, RUN_JOB, runJobSchema, threadOf, type RunJobData } from './jobs.js';
import type { ThreadScheduler } from './thread-scheduler.js';

export interface RunProducer {
  enqueue(data: RunJobData): Promise<string>;
}

export class BullRunProducer implements RunProducer {
  constructor(
    private readonly queue: Queue,
    private readonly scheduler: ThreadScheduler,
  ) {}

  /**
   * Record the job's place in its thread, then enqueue it. If enqueueing fails after the
   * register step, the worker's stale-entry check removes the orphan, so the thread does
   * not stall.
   */
  async enqueue(data: RunJobData): Promise<string> {
    const parsed = runJobSchema.parse(data);
    const jobId = jobIdFor(parsed.eventId);
    await this.scheduler.register(threadOf(parsed), jobId, parsed.messageTs);
    await this.queue.add(RUN_JOB, parsed, {
      jobId,
      attempts: 1,
      removeOnComplete: { age: 60 * 60, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
    return jobId;
  }
}
