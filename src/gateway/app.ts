import { App, HTTPReceiver, LogLevel, type Logger as BoltLogger, type Receiver } from '@slack/bolt';
import type { Logger } from 'pino';

import type { SlackConfig } from '../config/env.js';
import { handleMention, type MentionDeps, type MentionOutcome } from './mention-handler.js';

export interface SlackAppOptions {
  readonly slack: SlackConfig;
  readonly deps: MentionDeps;
  readonly logger: Logger;
  /** Called after each mention is handled; tests use it to observe outcomes. */
  readonly onHandled?: (outcome: MentionOutcome, eventId: string) => void;
}

function boltLogger(logger: Logger): BoltLogger {
  const child = logger.child({ component: 'bolt' });
  return {
    debug: (...msg: unknown[]) => {
      child.debug(msg.map(String).join(' '));
    },
    info: (...msg: unknown[]) => {
      child.info(msg.map(String).join(' '));
    },
    warn: (...msg: unknown[]) => {
      child.warn(msg.map(String).join(' '));
    },
    error: (...msg: unknown[]) => {
      child.error(msg.map(String).join(' '));
    },
    setLevel: () => undefined,
    getLevel: () => LogLevel.INFO,
    setName: () => undefined,
  };
}

/**
 * The Slack gateway. Bolt verifies request signatures (HTTP mode) and acknowledges each
 * event before our listener runs, so the 3-second ack never depends on our own work.
 */
export function createSlackApp(options: SlackAppOptions): {
  app: App;
  receiver: Receiver | undefined;
} {
  const { slack, logger } = options;
  if (slack.botToken === undefined) throw new Error('SLACK_BOT_TOKEN is required');
  const bolt = boltLogger(logger);
  const clientOptions = {
    ...(slack.apiUrl === undefined ? {} : { slackApiUrl: slack.apiUrl }),
    retryConfig: { retries: 3, factor: 2, minTimeout: 500, maxTimeout: 5_000 },
  };

  let app: App;
  let receiver: HTTPReceiver | undefined;
  if (slack.transport === 'socket') {
    if (slack.appToken === undefined)
      throw new Error('SLACK_APP_TOKEN is required for socket mode');
    app = new App({
      token: slack.botToken,
      appToken: slack.appToken,
      socketMode: true,
      logger: bolt,
      clientOptions,
    });
  } else {
    if (slack.signingSecret === undefined)
      throw new Error('SLACK_SIGNING_SECRET is required for http mode');
    receiver = new HTTPReceiver({
      signingSecret: slack.signingSecret,
      endpoints: '/slack/events',
      logger: bolt,
      processBeforeResponse: false,
    });
    app = new App({ token: slack.botToken, receiver, logger: bolt, clientOptions });
  }

  app.event('app_mention', async ({ event, body, context }) => {
    const botUserId = context.botUserId;
    if (botUserId === undefined) {
      logger.error('bot user id unknown; ignoring the mention');
      return;
    }
    const outcome = await handleMention(
      {
        eventId: body.event_id,
        teamId: body.team_id,
        channel: event.channel,
        user: event.user,
        botId: event.bot_id,
        text: event.text,
        ts: event.ts,
        threadTs: event.thread_ts,
      },
      botUserId,
      options.deps,
    );
    if (context.retryNum !== undefined) {
      logger.info(
        { retryNum: context.retryNum, reason: context.retryReason, outcome },
        'Slack retry',
      );
    }
    options.onHandled?.(outcome, body.event_id);
  });

  app.error((error) => {
    logger.error({ err: error }, 'unhandled Slack app error');
    return Promise.resolve();
  });

  return { app, receiver };
}
