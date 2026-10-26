import { LogLevel, WebClient, type Logger as SlackLogger } from '@slack/web-api';
import type { Logger } from 'pino';

/** A message in a Slack thread, reduced to what the bot needs. */
export interface ThreadMessage {
  readonly ts: string;
  readonly userId: string | undefined;
  readonly botId: string | undefined;
  readonly text: string;
}

/**
 * The Slack operations the bot uses. The gateway and the worker depend on this port,
 * not on the WebClient, so tests can run against a fake Slack API.
 */
export interface SlackApi {
  /** Post a reply in a thread. Text is sent as-is; escape untrusted text first. */
  postInThread(channel: string, threadTs: string, text: string): Promise<string>;
  update(channel: string, ts: string, text: string): Promise<void>;
  /** Thread messages oldest first, up to and including `latest`, at most `limit` of them. */
  threadMessages(
    channel: string,
    threadTs: string,
    opts: { readonly latest: string; readonly limit: number },
  ): Promise<ThreadMessage[]>;
  userName(userId: string): Promise<string>;
}

export interface SlackApiOptions {
  readonly token: string;
  readonly apiUrl?: string | undefined;
  readonly logger: Logger;
  /** Retries for failed calls. Rate-limited calls wait for Retry-After and then retry. */
  readonly retries?: number;
}

const USER_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_PAGES = 5;

/** Route the WebClient's logging into our pino logger. */
function slackLogger(logger: Logger): SlackLogger {
  const child = logger.child({ component: 'slack-web-api' });
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

export function createWebClient(options: SlackApiOptions): WebClient {
  return new WebClient(options.token, {
    ...(options.apiUrl === undefined ? {} : { slackApiUrl: options.apiUrl }),
    logger: slackLogger(options.logger),
    retryConfig: { retries: options.retries ?? 3, factor: 2, minTimeout: 500, maxTimeout: 5_000 },
    timeout: 15_000,
  });
}

export class WebClientSlackApi implements SlackApi {
  private readonly users = new Map<string, { name: string; expires: number }>();

  constructor(private readonly client: WebClient) {}

  async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
    const result = await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      parse: 'none',
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (result.ts === undefined) throw new Error('chat.postMessage returned no ts');
    return result.ts;
  }

  async update(channel: string, ts: string, text: string): Promise<void> {
    await this.client.chat.update({ channel, ts, text, parse: 'none', link_names: false });
  }

  async threadMessages(
    channel: string,
    threadTs: string,
    opts: { readonly latest: string; readonly limit: number },
  ): Promise<ThreadMessage[]> {
    const messages: ThreadMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.client.conversations.replies({
        channel,
        ts: threadTs,
        latest: opts.latest,
        inclusive: true,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const m of result.messages ?? []) {
        if (m.ts === undefined) continue;
        messages.push({ ts: m.ts, userId: m.user, botId: m.bot_id, text: m.text ?? '' });
      }
      cursor = result.response_metadata?.next_cursor;
      if (cursor === undefined || cursor === '') break;
    }
    return messages.filter((m) => Number(m.ts) <= Number(opts.latest)).slice(-opts.limit);
  }

  async userName(userId: string): Promise<string> {
    const cached = this.users.get(userId);
    if (cached !== undefined && cached.expires > Date.now()) return cached.name;
    let name = userId;
    try {
      const result = await this.client.users.info({ user: userId });
      const profile = result.user?.profile;
      name =
        nonEmpty(profile?.display_name) ??
        nonEmpty(profile?.real_name) ??
        nonEmpty(result.user?.name) ??
        userId;
    } catch {
      // A missing name is not worth failing a run; fall back to the id.
    }
    this.users.set(userId, { name, expires: Date.now() + USER_CACHE_TTL_MS });
    return name;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}
