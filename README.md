# madar

A chat-triggered QA agent with its own sandbox. Mention it in Slack; it runs a Claude agent loop inside an isolated per-thread sandbox, uses GitHub and Jira through MCP connectors, and replies in the thread. Risky actions need human approval. The first use case is Playwright failure triage.

The full specification is [docs/brief.md](docs/brief.md) (v2.2). The project is built phase by phase, and each phase ends at a gate the owner approves.

## Status

**Phase 1 (Slack gateway and agent loop) is built and awaiting its gate demo.** Mention the bot in an allowlisted channel and it answers in the thread. It has no tools yet: no sandbox, repos or CI access.

| Phase | Scope                                                                             | State       |
| ----- | --------------------------------------------------------------------------------- | ----------- |
| 0     | Scaffold, config, logging, local services, threat model, decisions, triage rubric | Passed      |
| 1     | Slack gateway and agent loop (no sandbox)                                         | Gate review |
| 2     | Sandbox per thread                                                                | Not started |
| 3     | Read-only connectors, secrets proxy, redaction                                    | Not started |
| 4     | Failure triage pilot (read-only)                                                  | Not started |
| 5     | Policy, approvals, audit                                                          | Not started |
| 6     | Test generation, healing, test data, release readiness                            | Not started |
| 7     | Proactive triggers and memory                                                     | Not started |
| 8     | Evals, observability, hardening                                                   | Not started |

## Quick start

Requires Node 22.12+, pnpm 10 (via `corepack enable`) and Docker.

```sh
pnpm install
pnpm test                     # unit tests; integration tests skip without services
docker compose up -d --wait   # Redis and Postgres on 127.0.0.1
cp .env.example .env          # then fill in the Slack and Claude keys
pnpm migrate
pnpm dev                      # gateway and worker in one process
```

Creating the Slack app, choosing a channel and the demo script: **[docs/slack-setup.md](docs/slack-setup.md)**.

## Using it in Slack

| Say                                            | What happens                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `@madar <question>`                            | A `⏳` reply appears in the thread, updates as the answer streams, then becomes the answer. The bot reads the thread for context. |
| `@madar <another question>` in the same thread | Waits for the current request in that thread, then answers.                                                                       |
| `@madar stop`                                  | Stops the current request and anything queued behind it in the thread.                                                            |
| `@madar help`                                  | Usage.                                                                                                                            |

The bot answers only in channels listed in [`config/projects.json`](config/README.md).

## Scripts

| Command                             | What it does                                                               |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `pnpm dev`                          | Gateway and worker in one process, restarting on changes                   |
| `pnpm migrate`                      | Apply database migrations                                                  |
| `pnpm build` / `pnpm start`         | Compile to `dist/` and run (`node dist/main.js <role>`)                    |
| `pnpm check`                        | Typecheck, lint, format check, tests                                       |
| `pnpm test` / `pnpm test:watch`     | Vitest; set `TEST_REDIS_URL` and `TEST_DATABASE_URL` for integration tests |
| `pnpm format` / `pnpm format:check` | Prettier                                                                   |

Roles, logs and incident steps: [docs/runbook.md](docs/runbook.md).

## What's built

**Phase 1**

- **Gateway** (`src/gateway/`):
  - Bolt in Socket Mode, or HTTP with signature checks; events are acked before any work.
  - Dedupe by event id, the channel allowlist, a per-user rate limit and immediate `stop` and `help`.
  - One placeholder per request.
- **Queue** (`src/queue/`):
  - BullMQ with a Redis scheduler for strict per-thread order.
  - Jobs carry ids only.
  - A run whose worker dies restarts once, then is marked interrupted, so each request still has exactly one outcome.
- **Agent** (`src/agent/`):
  - The Claude Agent SDK with built-in tools off, no settings files, and a minimal subprocess environment (D-001).
  - Turn, token, cost and time budgets.
  - The thread goes to the model as JSON tagged by author; answers are escaped so they can't ping or mention anyone.
- **Audit** (`src/audit/`): run state and an append-only audit log in Postgres. No run without an audit record, and no answer posted without recording it.

**Phase 0**

- Typed config and JSON logging with correlation ids.
- Local services and CI.
- The [threat model](docs/threat-model.md), [decisions](docs/decisions.md), [data handling](docs/data-handling.md), [architecture](docs/architecture.md) and the [build-vs-buy spike](docs/spike-build-vs-buy.md).
- The [triage eval set](evals/triage/README.md) scaffolding.

## Tests

The suite:

- Unit tests run anywhere.
- Integration tests use real Redis, Postgres, BullMQ, Bolt and the Agent SDK, against fake Slack and Claude APIs in `test/fakes/`. They cover ordering, dedupe, the allowlist, stop, the rate limit, the audit store being down, signed HTTP with ack timing, workers killed with SIGKILL in child processes, and the real entry point end to end.

CI runs everything with `REQUIRE_INTEGRATION=1`.

## Layout

```text
src/
  main.ts          # entry point: gateway | worker | all | migrate
  gateway/ authz/ queue/ agent/ audit/ config/ shared/   # built (each has a README)
  sandbox/ egress/ policy/ approvals/ mcp/ redaction/ qa/ triggers/ memory/   # later phases
config/            # projects.json, the project map
migrations/        # SQL migrations
slack/             # Slack app manifest
test/              # fakes, helpers, integration tests
sandbox-image/     # Phase 2
evals/             # triage (Phase 0 onward), injection, test-gen, healing
docs/
```

## Ground rules

- No secrets in the repo. `.env` is git-ignored; `.env.example` holds local-only values.
- Dependencies are pinned to exact versions.
- Decisions are recorded in [docs/decisions.md](docs/decisions.md), including where the brief had to bend.
