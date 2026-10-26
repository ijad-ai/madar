import type { Logger } from 'pino';

import type { SlackApi } from '../gateway/slack-api.js';

/**
 * Edits one placeholder message as a run makes progress, at most once per interval.
 * Updates are best effort: a failed or rate-limited edit is skipped, never retried, and
 * never blocks the run. Only the latest text is ever sent.
 */
export class ProgressUpdater {
  private latest: string | undefined;
  private lastSent: string | undefined;
  private lastSentAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly slack: SlackApi,
    private readonly channel: string,
    private readonly ts: string,
    private readonly everyMs: number,
    private readonly logger: Logger,
  ) {}

  set(text: string): void {
    if (this.stopped) return;
    this.latest = text;
    this.schedule();
  }

  /** Stop sending. Waits for an edit already in flight, so it cannot land after the final text. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private schedule(): void {
    if (this.timer !== undefined || this.inFlight !== undefined) return;
    const wait = Math.max(0, this.lastSentAt + this.everyMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.flush().finally(() => {
        this.inFlight = undefined;
        if (!this.stopped && this.latest !== this.lastSent) this.schedule();
      });
    }, wait);
  }

  private async flush(): Promise<void> {
    const text = this.latest;
    if (this.stopped || text === undefined || text === this.lastSent) return;
    try {
      await this.slack.update(this.channel, this.ts, text);
      this.lastSent = text;
    } catch (error) {
      this.logger.debug({ err: error }, 'progress update skipped');
    } finally {
      this.lastSentAt = Date.now();
    }
  }
}
