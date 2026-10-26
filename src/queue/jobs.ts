import { z } from 'zod';

import type { RunKey } from '../audit/run-store.js';
import type { ThreadRef } from './thread-scheduler.js';

export const RUN_QUEUE = 'madar-runs';
export const RUN_JOB = 'run';

const slackTs = z.string().regex(/^\d{9,11}\.\d{6}$/, 'must be a Slack timestamp');
const slackId = z.string().regex(/^[A-Z0-9]{6,20}$/, 'must be a Slack id');

/**
 * What a queued job carries: ids only, never message text (data-handling.md). The
 * worker reads the thread from Slack when the run starts.
 */
export const runJobSchema = z.strictObject({
  v: z.literal(1),
  eventId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/, 'must be a Slack event id'),
  teamId: slackId,
  channelId: slackId,
  threadTs: slackTs,
  messageTs: slackTs,
  requesterId: slackId,
  projectId: z.string().min(1).max(64),
  placeholderTs: slackTs.optional(),
  receivedAt: z.number().int().positive(),
});

export type RunJobData = z.infer<typeof runJobSchema>;

/** BullMQ forbids ':' in custom ids; Slack event ids never contain one. */
export function jobIdFor(eventId: string): string {
  return `evt-${eventId}`;
}

export function threadOf(data: RunJobData): ThreadRef {
  return { teamId: data.teamId, channelId: data.channelId, threadTs: data.threadTs };
}

export function runKeyOf(jobId: string, data: RunJobData): RunKey {
  return {
    jobId,
    eventId: data.eventId,
    teamId: data.teamId,
    channelId: data.channelId,
    threadTs: data.threadTs,
    messageTs: data.messageTs,
    requesterId: data.requesterId,
    projectId: data.projectId,
    queuedAt: new Date(data.receivedAt),
  };
}
