# gateway

**Phase 1.** Slack Bolt app: signature verification, dedupe of Slack retries and duplicate events, ack within 3 seconds, and one job enqueued per event, keyed by `channel + thread_ts`.

Each event runs inside `withCorrelationId(event_id, …)` from `src/shared/`, so every log line for that request carries the same id.
