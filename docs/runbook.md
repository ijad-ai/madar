# Runbook

Status: Phase 1. Covers running the bot and the first incident steps. The full incident runbook (revoking connector tokens, killing sandboxes, purging a thread's data) lands in Phase 8.

## Processes

`madar <role>` runs one of four roles. In development use `pnpm tsx src/main.ts <role>`; after `pnpm build`, use `node dist/main.js <role>`.

| Role      | What it does                                             | Needs                                                                                      |
| --------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `migrate` | Applies database migrations, then exits                  | `DATABASE_URL`                                                                             |
| `gateway` | Receives Slack events, posts placeholders, enqueues runs | Redis, `SLACK_BOT_TOKEN`, plus `SLACK_APP_TOKEN` (socket) or `SLACK_SIGNING_SECRET` (http) |
| `worker`  | Runs queued requests through the agent                   | Redis, Postgres (migrated), `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`                         |
| `all`     | Gateway and worker in one process, for development       | Everything above                                                                           |

Every process checks its configuration at start and lists all missing variables at once. The worker refuses to start if the database is behind the code.

## Local services

```sh
cp .env.example .env          # first time only
docker compose up -d --wait   # Redis and Postgres, bound to 127.0.0.1
pnpm migrate
pnpm dev                      # role "all", restarts on file changes
docker compose down           # stop, keep data
docker compose down -v        # stop and delete local data
```

To use a different local Postgres password, set `POSTGRES_PASSWORD` in `.env` before the first `up`, and update `DATABASE_URL` to match. Changing it later needs `docker compose down -v`, because Postgres keeps the password it was initialised with.

Slack app setup and the demo: [slack-setup.md](slack-setup.md).

## Checks

```sh
pnpm check   # typecheck, lint, format check, tests
TEST_REDIS_URL=redis://127.0.0.1:6379 \
TEST_DATABASE_URL=postgres://madar:madar_local_dev@127.0.0.1:5432/madar \
pnpm test    # include the integration tests (needs docker compose up)
```

Integration tests create and drop their own databases and Redis key prefixes. CI runs them with `REQUIRE_INTEGRATION=1`, so missing services fail the build instead of being skipped.

## Logs

Logs are JSON lines on stdout. Fields: `service`, `role`, `level`, `time`, `msg`, and inside a request `correlationId` (the Slack event id), `jobId`, `channel` and `thread`. Credentials under known keys show as `[REDACTED]`. No message text is logged.

| Message                                               | Meaning                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `run queued`                                          | The gateway accepted a request (`queuedBehind: true` if another run is ahead in the thread) |
| `run finished`                                        | The worker posted an outcome; `outcome` and `usage` say how it went                         |
| `duplicate event ignored`                             | Slack retried an event that was already handled                                             |
| `mention in a channel that is not in the project map` | Someone tried the bot outside the allowlist                                                 |
| `audit store unavailable; refusing the run`           | Postgres is down; runs are refused until it's back                                          |
| `job stalled; it will be picked up again`             | A worker died mid-run; another worker restarts it once                                      |

## Incident steps (Phase 1)

| Situation                           | Do this                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stop the bot answering anywhere** | Stop the gateway processes. Queued runs finish; new mentions get no reply. To also stop queued runs, stop the workers.                                                                                                                                                  |
| **Stop it in one channel**          | Remove the channel from `config/projects.json` and restart the gateway.                                                                                                                                                                                                 |
| **Stop one runaway request**        | `@madar stop` in its thread.                                                                                                                                                                                                                                            |
| **Leaked Slack or Claude key**      | Revoke it in Slack's app settings or the Claude Console, put the new value in the deployment's secrets, restart the affected processes.                                                                                                                                 |
| **Find what a run did**             | Error and interruption replies include the run id as their reference. Otherwise find the run by thread: `select id, status, outcome from runs where channel_id = '<C…>' and thread_ts = '<ts>';`, then `select * from audit_events where run_id = '<id>' order by id;`. |
| **Postgres down**                   | Runs are refused and say why in the thread. Restore Postgres; nothing else is needed.                                                                                                                                                                                   |
| **Redis down**                      | The gateway replies that its queue is unavailable. Restore Redis; jobs already queued survive (AOF on).                                                                                                                                                                 |
