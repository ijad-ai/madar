# madar

A chat-triggered QA agent with its own sandbox. Mention it in Slack; it runs a Claude agent loop inside an isolated per-thread sandbox, uses GitHub and Jira through MCP connectors, and replies in the thread. Risky actions need human approval. The first use case is Playwright failure triage.

The full specification is [docs/brief.md](docs/brief.md) (v2.2). The project is built phase by phase, and each phase ends at a gate the owner approves.

## Status

**Phase 0 (foundations and decisions): built, awaiting gate review.** No Slack, agent or sandbox code exists yet; that starts in Phase 1.

| Phase | Scope                                                                             | State       |
| ----- | --------------------------------------------------------------------------------- | ----------- |
| 0     | Scaffold, config, logging, local services, threat model, decisions, triage rubric | Gate review |
| 1     | Slack gateway and agent loop (no sandbox)                                         | Not started |
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
pnpm test
docker compose up -d --wait   # Redis and Postgres on 127.0.0.1
cp .env.example .env          # for running code locally
```

## Scripts

| Command                             | What it does                                             |
| ----------------------------------- | -------------------------------------------------------- |
| `pnpm check`                        | Everything CI runs: typecheck, lint, format check, tests |
| `pnpm typecheck`                    | `tsc --noEmit` in strict mode                            |
| `pnpm lint`                         | ESLint with the type-checked strict ruleset              |
| `pnpm format` / `pnpm format:check` | Prettier                                                 |
| `pnpm test` / `pnpm test:watch`     | Vitest                                                   |

## Phase 0: what's here

- **Config** (`src/config/`): environment validated with Zod. Errors name variables, never values. Production refuses plaintext Redis and Postgres. [Details](src/config/README.md)
- **Logging** (`src/shared/`): pino JSON logs with a correlation id per request, carried across awaits. Credentials under known keys are redacted. [Details](src/shared/README.md)
- **Local services** (`docker-compose.yml`): Redis 8 (no eviction, AOF) and Postgres 18, bound to localhost.
- **CI** (`.github/workflows/ci.yml`): typecheck, lint, format, tests, and a job that runs `docker compose up --wait` and checks both services.
- **Docs**: [architecture](docs/architecture.md), [threat model](docs/threat-model.md), [data handling](docs/data-handling.md), [decisions](docs/decisions.md), [build-vs-buy spike](docs/spike-build-vs-buy.md), [runbook](docs/runbook.md).
- **Triage eval set** (`evals/triage/`): [rubric](evals/triage/rubric.md), [anonymization procedure](evals/triage/anonymization.md), record schema and a leak guard that CI runs on every record.

## Layout

```text
src/
  gateway/ authz/ queue/ agent/ sandbox/ egress/ policy/ approvals/
  mcp/ redaction/ qa/ triggers/ memory/ audit/   # each has a README saying which phase builds it
  config/   # Phase 0: Zod env config
  shared/   # Phase 0: logger and correlation ids (decision D-011)
sandbox-image/  # Phase 2
evals/          # triage (Phase 0 onward), injection, test-gen, healing
docs/
```

## Ground rules

- No secrets in the repo. `.env` is git-ignored; `.env.example` holds local-only values.
- Dependencies are pinned to exact versions.
- Decisions are recorded in [docs/decisions.md](docs/decisions.md), including where the brief had to bend.
