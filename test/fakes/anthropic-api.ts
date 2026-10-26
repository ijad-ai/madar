import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeReply =
  | {
      readonly kind: 'text';
      readonly text: string;
      /** Split the text into this many streamed deltas. */
      readonly chunks?: number;
      readonly chunkDelayMs?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    }
  | {
      readonly kind: 'error';
      readonly status: number;
      readonly type: string;
      readonly message: string;
    }
  /** Accept the request and never answer, for timeout and cancel tests. */
  | { readonly kind: 'hang' };

export interface RecordedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
  /** Concatenated text of all user content, for routing replies in tests. */
  readonly userText: string;
}

/**
 * A minimal Anthropic Messages API that streams scripted replies. Tests point the real
 * Agent SDK at it with ANTHROPIC_BASE_URL, so the real subprocess, options and message
 * stream are exercised with no network and no API key.
 */
export class FakeAnthropicApi {
  readonly requests: RecordedRequest[] = [];
  /** Chooses the reply for each request. Defaults to a short greeting. */
  handler: (request: RecordedRequest) => FakeReply = () => ({
    kind: 'text',
    text: 'Hello from the fake API.',
  });
  private server: Server | undefined;
  private readonly open = new Set<ServerResponse>();

  get url(): string {
    const address = this.server?.address() as AddressInfo | null | undefined;
    if (address === null || address === undefined)
      throw new Error('fake Anthropic API not started');
    return `http://127.0.0.1:${address.port}`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async stop(): Promise<void> {
    for (const res of this.open) res.destroy();
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = req.url ?? '';
    if (req.method !== 'POST' || !url.startsWith('/v1/messages') || url.includes('count_tokens')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: url } }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const recorded: RecordedRequest = { url, body, userText: userTextOf(body) };
    this.requests.push(recorded);
    const reply = this.handler(recorded);

    if (reply.kind === 'error') {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ type: 'error', error: { type: reply.type, message: reply.message } }),
      );
      return;
    }
    this.open.add(res);
    res.on('close', () => this.open.delete(res));
    if (reply.kind === 'hang') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return;
    }
    await this.stream(res, String(body['model']), reply);
  }

  private async stream(
    res: ServerResponse,
    model: string,
    reply: Extract<FakeReply, { kind: 'text' }>,
  ): Promise<void> {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (type: string, data: Record<string, unknown>) => {
      if (!res.destroyed)
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    };
    send('message_start', {
      message: {
        id: `msg_${String(this.requests.length)}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: reply.inputTokens ?? 25, output_tokens: 1 },
      },
    });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    const parts = splitInto(reply.text, reply.chunks ?? 1);
    for (const part of parts) {
      if (res.destroyed) return;
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } });
      if ((reply.chunkDelayMs ?? 0) > 0) await sleep(reply.chunkDelayMs ?? 0);
    }
    send('content_block_stop', { index: 0 });
    send('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: reply.outputTokens ?? Math.max(1, Math.ceil(reply.text.length / 4)) },
    });
    send('message_stop', {});
    res.end();
  }
}

function userTextOf(body: Record<string, unknown>): string {
  const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
  const texts: string[] = [];
  for (const message of messages) {
    const m = message as { role?: string; content?: unknown };
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') texts.push(m.content);
    if (Array.isArray(m.content)) {
      for (const block of m.content as { type?: string; text?: string }[]) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      }
    }
  }
  return texts.join('\n');
}

function splitInto(text: string, n: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, n)));
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.length === 0 ? [''] : parts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
