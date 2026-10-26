# Runbook

Status: Phase 0. Covers local development only. Incident steps (disable the bot, revoke tokens, kill sandboxes, purge a thread's data) land in Phase 8.

## Local services

```sh
cp .env.example .env          # first time only
docker compose up -d --wait   # Redis and Postgres, bound to 127.0.0.1
docker compose ps
docker compose logs -f postgres
docker compose down           # stop, keep data
docker compose down -v        # stop and delete local data
```

Use a different local Postgres password by setting `POSTGRES_PASSWORD` in `.env` before the first `up`, and update `DATABASE_URL` to match. Changing it later needs `docker compose down -v`, because Postgres keeps the password it was initialised with.

## Checks

```sh
pnpm check   # typecheck, lint, format check, tests (what CI runs)
```

## Logs

Logs are JSON lines on stdout: `service`, `level`, `time`, `msg`, and `correlationId` inside a request. Credentials under known keys are replaced with `[REDACTED]`.
