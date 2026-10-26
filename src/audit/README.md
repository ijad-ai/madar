# audit

- **Phase 1:** basic run rows (run id, user, thread, model, token usage, outcome). If the audit store is unavailable, the agent refuses to run.
- **Phase 5:** the append-only store for prompts, tool calls, commands, approvals, policy decisions, redaction events and cost, plus `trace export`.

Retention and access rules: `docs/data-handling.md`.
