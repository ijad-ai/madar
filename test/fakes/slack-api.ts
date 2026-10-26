import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A message as the fake Slack workspace stores it. */
export interface FakeMessage {
  ts: string;
  threadTs: string | undefined;
  channel: string;
  user: string | undefined;
  botId: string | undefined;
  text: string;
  edits: string[];
}

export interface FakeCall {
  readonly method: string;
  readonly args: Record<string, unknown>;
}

export const FAKE_TEAM = 'T0FAKE0001';
export const FAKE_BOT_USER = 'U0BOT00001';
export const FAKE_BOT_ID = 'B0BOT00001';

/**
 * An in-memory Slack Web API, good enough for the calls the bot makes. Tests point the
 * real WebClient at it with `slackApiUrl`, so the client code path is exercised too.
 */
export class FakeSlackApi {
  readonly calls: FakeCall[] = [];
  readonly messages: FakeMessage[] = [];
  readonly users = new Map<string, string>([['U0ALICE001', 'alice']]);
  private server: Server | undefined;
  private clock = 1_761_000_000;
  private seq = 0;
  private failures = new Map<string, string>();

  get url(): string {
    const address = this.server?.address() as AddressInfo | null | undefined;
    if (address === null || address === undefined) throw new Error('fake Slack API not started');
    return `http://127.0.0.1:${address.port}/api/`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        (body) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        },
        (error: unknown) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
        },
      );
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server === undefined) {
        resolve();
        return;
      }
      this.server.closeAllConnections();
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** Make the next call to `method` fail with a Slack error code. */
  failNext(method: string, error: string): void {
    this.failures.set(method, error);
  }

  nextTs(): string {
    this.seq += 1;
    return `${this.clock}.${String(this.seq).padStart(6, '0')}`;
  }

  /** Add a message from a person, as if they typed it in Slack. */
  addUserMessage(channel: string, text: string, opts: { threadTs?: string; user?: string } = {}) {
    const message: FakeMessage = {
      ts: this.nextTs(),
      threadTs: opts.threadTs,
      channel,
      user: opts.user ?? 'U0ALICE001',
      botId: undefined,
      text,
      edits: [],
    };
    this.messages.push(message);
    return message;
  }

  /** All messages in a thread (root first), in order. */
  thread(channel: string, threadTs: string): FakeMessage[] {
    return this.messages.filter(
      (m) => m.channel === channel && (m.ts === threadTs || m.threadTs === threadTs),
    );
  }

  botReplies(channel: string, threadTs: string): FakeMessage[] {
    return this.thread(channel, threadTs).filter((m) => m.botId !== undefined);
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  private async handle(req: IncomingMessage): Promise<Record<string, unknown>> {
    const method = (req.url ?? '').replace(/^\/api\//, '').split('?')[0] ?? '';
    const args = await readArgs(req);
    this.calls.push({ method, args });
    const failure = this.failures.get(method);
    if (failure !== undefined) {
      this.failures.delete(method);
      return { ok: false, error: failure };
    }
    switch (method) {
      case 'auth.test':
        return { ok: true, user_id: FAKE_BOT_USER, bot_id: FAKE_BOT_ID, team_id: FAKE_TEAM };
      case 'chat.postMessage': {
        const message: FakeMessage = {
          ts: this.nextTs(),
          threadTs: str(args['thread_ts']),
          channel: str(args['channel']) ?? '',
          user: FAKE_BOT_USER,
          botId: FAKE_BOT_ID,
          text: str(args['text']) ?? '',
          edits: [],
        };
        this.messages.push(message);
        return { ok: true, channel: message.channel, ts: message.ts };
      }
      case 'chat.update': {
        const message = this.messages.find(
          (m) => m.channel === str(args['channel']) && m.ts === str(args['ts']),
        );
        if (message === undefined) return { ok: false, error: 'message_not_found' };
        message.edits.push(message.text);
        message.text = str(args['text']) ?? '';
        return { ok: true, channel: message.channel, ts: message.ts };
      }
      case 'conversations.replies': {
        const channel = str(args['channel']) ?? '';
        const ts = str(args['ts']) ?? '';
        const latest = Number(str(args['latest']) ?? Infinity);
        const messages = this.thread(channel, ts)
          .filter((m) => Number(m.ts) <= latest)
          .map((m) => ({
            ts: m.ts,
            thread_ts: m.threadTs ?? m.ts,
            user: m.user,
            ...(m.botId === undefined ? {} : { bot_id: m.botId }),
            text: m.text,
          }));
        return { ok: true, messages, has_more: false };
      }
      case 'users.info': {
        const user = str(args['user']) ?? '';
        const name = this.users.get(user);
        if (name === undefined) return { ok: false, error: 'user_not_found' };
        return { ok: true, user: { id: user, name, profile: { display_name: name } } };
      }
      default:
        return { ok: false, error: 'unknown_method' };
    }
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function readArgs(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    return raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
  }
  return Object.fromEntries(new URLSearchParams(raw));
}
