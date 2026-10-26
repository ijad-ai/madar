# audit

- **Phase 1 (built):**
  - `runs` holds each request's state, outcome, attempt and usage.
  - `audit_events` is append-only, enforced by a trigger.
  - `run-store.ts` tells new, restarted and already-finished runs apart.
  - `migrate.ts` applies `migrations/*.sql` under an advisory lock.
  - No message content is stored.
- **Phase 5:** prompts, tool calls, commands, approvals, policy decisions and redaction events, plus `trace export`.

Retention and access rules: `docs/data-handling.md`.
