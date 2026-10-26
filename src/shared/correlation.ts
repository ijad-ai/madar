import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

interface RequestContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Ids we accept from outside (Slack event ids, `channel:thread_ts`, CI run ids).
 * Anything else is replaced, so a crafted id cannot inject fake log fields or lines.
 */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function normalizeCorrelationId(candidate: unknown): string {
  return typeof candidate === 'string' && SAFE_ID.test(candidate) ? candidate : randomUUID();
}

/**
 * Run `fn` with a correlation id that every log line inside it carries, across awaits.
 * Pass an inbound id (for example a Slack event id) or nothing to generate one.
 */
export function withCorrelationId<T>(candidate: unknown, fn: () => T): T {
  return storage.run({ correlationId: normalizeCorrelationId(candidate) }, fn);
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
