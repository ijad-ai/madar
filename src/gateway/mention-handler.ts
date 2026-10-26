import type { Logger } from 'pino';

import type { ProjectMap } from '../authz/projects.js';
import type { RunProducer } from '../queue/producer.js';
import type { ThreadRef, ThreadScheduler } from '../queue/thread-scheduler.js';
import type { EventDeduper, UserRateLimiter } from './guards.js';
import { text } from './messages.js';
import type { SlackApi } from './slack-api.js';
import { parseMention } from './slack-text.js';

export interface MentionEvent {
  readonly eventId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly user: string | undefined;
  readonly botId: string | undefined;
  readonly text: string;
  readonly ts: string;
  readonly threadTs: string | undefined;
}

export type MentionOutcome =
  | 'ignored_bot'
  | 'duplicate'
  | 'not_enabled'
  | 'help'
  | 'empty'
  | 'stopped'
  | 'nothing_to_stop'
  | 'rate_limited'
  | 'queued'
  | 'queue_unavailable';

export interface MentionDeps {
  readonly projects: ProjectMap;
  readonly slack: SlackApi;
  readonly producer: RunProducer;
  readonly scheduler: ThreadScheduler;
  readonly deduper: EventDeduper;
  readonly rateLimiter: UserRateLimiter;
  readonly ratePerHour: number;
  readonly logger: Logger;
}

/**
 * Handles one @mention. It never runs the agent: it decides whether the mention may
 * become a run, posts the run's single placeholder, and enqueues ids only. Commands
 * (`stop`, `help`) are answered here, immediately, instead of queuing behind a run.
 */
export async function handleMention(
  event: MentionEvent,
  botUserId: string,
  deps: MentionDeps,
): Promise<MentionOutcome> {
  const log = deps.logger.child({ eventId: event.eventId, channel: event.channel });
  const threadTs = event.threadTs ?? event.ts;
  const thread: ThreadRef = { teamId: event.teamId, channelId: event.channel, threadTs };
  const reply = async (message: string): Promise<string | undefined> => {
    try {
      return await deps.slack.postInThread(event.channel, threadTs, message);
    } catch (error) {
      log.warn({ err: error }, 'could not reply in Slack');
      return undefined;
    }
  };

  if (event.botId !== undefined || event.user === undefined || event.user === botUserId) {
    return 'ignored_bot';
  }
  const user = event.user;

  try {
    if (!(await deps.deduper.firstTime(event.eventId))) {
      log.info('duplicate event ignored');
      return 'duplicate';
    }
  } catch (error) {
    log.error({ err: error }, 'dedupe store unavailable');
    await reply(text.queueUnavailable);
    return 'queue_unavailable';
  }

  const project = deps.projects.projectForChannel(event.channel);
  if (project === undefined) {
    log.info('mention in a channel that is not in the project map');
    await reply(text.notEnabled);
    return 'not_enabled';
  }

  const command = parseMention(event.text, botUserId);
  try {
    switch (command.kind) {
      case 'help':
        await reply(text.help);
        return 'help';
      case 'empty':
        await reply(text.empty);
        return 'empty';
      case 'stop':
        if (await deps.scheduler.isBusy(thread)) {
          await deps.scheduler.requestStop(thread, event.ts, user);
          log.info({ user }, 'stop requested');
          await reply(text.stopAck);
          return 'stopped';
        }
        await reply(text.nothingToStop);
        return 'nothing_to_stop';
      case 'request':
        break;
    }

    if (!(await deps.rateLimiter.allow(user))) {
      log.info({ user }, 'rate limited');
      await reply(text.rateLimited(deps.ratePerHour));
      return 'rate_limited';
    }

    const busy = await deps.scheduler.isBusy(thread);
    const placeholderTs = await reply(busy ? text.queued : text.working);
    try {
      const jobId = await deps.producer.enqueue({
        v: 1,
        eventId: event.eventId,
        teamId: event.teamId,
        channelId: event.channel,
        threadTs,
        messageTs: event.ts,
        requesterId: user,
        projectId: project.id,
        ...(placeholderTs === undefined ? {} : { placeholderTs }),
        receivedAt: Date.now(),
      });
      log.info({ jobId, project: project.id, queuedBehind: busy }, 'run queued');
      return 'queued';
    } catch (error) {
      log.error({ err: error }, 'could not enqueue the run');
      if (placeholderTs === undefined) await reply(text.queueUnavailable);
      else
        await deps.slack
          .update(event.channel, placeholderTs, text.queueUnavailable)
          .catch(() => undefined);
      return 'queue_unavailable';
    }
  } catch (error) {
    log.error({ err: error }, 'queue store unavailable');
    await reply(text.queueUnavailable);
    return 'queue_unavailable';
  }
}
