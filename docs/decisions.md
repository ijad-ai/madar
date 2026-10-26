# Decisions

How to read this file:

- **Approved** decisions (D-001 to D-008) were proposed in Phase 0 and approved at the Phase 0 gate.
- **Defaulted** decisions were made during the build under working-agreement rule 5. Review them; change any you disagree with.
- **Conflicts** record where the brief turned out to be wrong or impossible (rule 9).
- Each phase gate is recorded at the bottom.

## Summary

| ID    | Decision                          | Status    | Proposal in one line                                                                    |
| ----- | --------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| D-001 | Runner placement                  | Approved  | Runner outside the sandbox; built-ins off; repo never on the worker                     |
| D-002 | Credential model                  | Approved  | URL rewriting for git and registries; staging users visible to the model, low-privilege |
| D-003 | Authorization model               | Approved  | Project map in a reviewed config file; per-user reads; no self-approval                 |
| D-004 | Run semantics                     | Approved  | Retry only before the first tool call; otherwise mark interrupted and ask               |
| D-005 | Slack transport in prod           | Approved  | Socket Mode, no public ingress                                                          |
| D-006 | Sandbox runtime                   | Approved  | gVisor required outside dev; 1 GiB `/dev/shm`; Chromium sandbox tried first             |
| D-007 | Data handling                     | Approved  | Redaction rules, 365/90-day audit retention, ZDR path for regulated projects            |
| D-008 | Warm start                        | Approved  | Registry cache + git mirrors + Playwright browser cache behind the proxy                |
| D-009 | TypeScript 6.0                    | Defaulted | typescript-eslint doesn't support TypeScript 7 yet                                      |
| D-010 | Repo and package name             | Defaulted | `madar`; the brief's `chat-agent/` root is this repo                                    |
| D-011 | `src/shared/` folder              | Defaulted | Logger and correlation ids live outside the brief's layout                              |
| D-012 | Image and action pinning          | Defaulted | Version tags now, digests and SHAs in Phase 8                                           |
| D-013 | Local Postgres password           | Defaulted | Local-only default so a clean clone starts                                              |
| D-014 | TLS required in production config | Defaulted | `rediss://` and `sslmode=require` or stricter                                           |
| D-015 | Redis 8                           | Defaulted | Matches the brief; Valkey is a drop-in if licensing prefers BSD                         |
| D-016 | Node and pnpm versions            | Defaulted | Node 22 (`>=22.12 <23`), pnpm 10.28                                                     |
| D-017 | Per-thread ordering               | Defaulted | A small Redis scheduler on top of open-source BullMQ                                    |
| D-018 | One placeholder per request       | Defaulted | The gateway posts it; the worker only ever edits it                                     |
| D-019 | Ids-only job payloads             | Defaulted | The worker reads the thread from Slack when the run starts                              |
| D-020 | Claude API retries                | Defaulted | Capped at 3 (`AGENT_API_MAX_RETRIES`); the SDK default is 10                            |
| D-021 | No session persistence in Phase 1 | Defaulted | Per-run directories deleted at run end; amends D-001                                    |
| D-022 | Token budget                      | Defaulted | Input, output and cache tokens, enforced mid-stream                                     |
| D-023 | Status for budget stops           | Defaulted | `failed`, with the limit that was hit in `outcome`                                      |
| D-024 | Default model                     | Defaulted | `claude-sonnet-5-5`, set per deployment with `AGENT_MODEL`                              |
| D-025 | Gateway audit rows                | Defaulted | None in Phase 1; gateway decisions go to logs                                           |
| D-026 | Scope of `stop`                   | Defaulted | Cancels the current run and everything queued before the stop                           |
| D-027 | Slack output escaping             | Defaulted | Model output can't mention, broadcast or disguise links                                 |
| D-028 | Per-user rate limit               | Defaulted | 30 requests per hour by default                                                         |
| D-029 | Who decides a restart             | Defaulted | The run processor; BullMQ's failure path is a backstop                                  |
| D-030 | Append-only audit log             | Defaulted | Enforced by a trigger; retention purges get a path in Phase 8                           |
| D-031 | Test seams                        | Defaulted | Fake API URLs and a run-directory hook; `SLACK_API_URL` refused in production           |
| D-032 | Redis key prefix                  | Defaulted | `REDIS_KEY_PREFIX` namespaces every key                                                 |

---

## Approved decisions (Phase 0 gate)

### D-001 Runner placement

**Context.** The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, checked at 0.3.310) runs a Claude Code subprocess wherever the runner runs. Its built-in tools (Bash, Read, Write and others) execute on that host, not in our sandbox.

**Options.**

- **A. Runner outside the sandbox** (in the worker), calling the sandbox through custom tools.
- **B. Runner inside the sandbox**, for example via the SDK's `spawnClaudeCodeProcess` hook.

**Proposal: A.** With B, the Claude API key (or a proxy route to the API) must exist inside the sandbox, which is where attacker-influenced code runs. With A, the sandbox holds no secrets at all.

How A is configured (option names taken from the SDK's type definitions):

- `tools: []` disables every built-in tool.
- Our tools are in-process MCP tools (`createSdkMcpServer` and `tool`) that call `SandboxProvider.exec`, `readFile` and `writeFile`.
- `allowedTools` lists only our tools, with `permissionMode: 'dontAsk'`, so anything else is denied rather than prompted.
- `toolAliases` maps built-in names (for example `Bash`) to our sandbox tools, in case the model emits them.
- `settingSources: []` stops the SDK loading user or project settings. This blocks T10: a repo that ships `.claude/settings.json` hooks or a `CLAUDE.md` cannot affect the worker.
- `cwd` is an empty per-run directory. The checked-out repo exists only inside the sandbox.
- `env` is passed explicitly with a minimal set of variables. The SDK replaces the subprocess environment with it, so connector tokens in the worker's environment never reach the subprocess.
- `maxTurns` and `maxBudgetUsd` carry the per-run budgets; sessions persist to a per-run config dir so Phase 5 can resume them. _(Phase 1 amendment: sessions are not persisted yet; see D-021.)_

**Consequences.** Every tool call is an RPC to the sandbox, which adds a few milliseconds per call. The worker host becomes sensitive (it holds the API key) and must not run untrusted code.

**Note for legal review.** The Agent SDK is distributed under Anthropic's commercial terms, not an open-source licence.

**Test (Phase 1).** The tool list reported at session start contains only our tools. A planted `.claude/settings.json` in `cwd` has no effect.

**Built in Phase 1.** `src/agent/claude-runner.ts`. Two settings the SDK needs that the proposal didn't list: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so the only network call is the model, and a per-run `HOME` and `CLAUDE_CONFIG_DIR`, so no user-level settings exist to load. The tests plant settings, hooks and `CLAUDE.md` in `cwd`, `HOME` and the config dir, and check none of them take effect (`claude-runner.test.ts`).

### D-002 Credential model

**Context.** A forward proxy cannot add headers inside an HTTPS CONNECT tunnel.

**Proposal.**

- **Git and registries: URL rewriting.** Inside the sandbox, `url.<base>.insteadOf` and the registry config point at plain-HTTP routes on the egress proxy, for example `http://egress:8080/git/github.com/<org>/<repo>.git`. The proxy upgrades to HTTPS and adds credentials. Plain HTTP is acceptable on this hop because the sandbox network is internal-only.
- **Route scoping.** Git: `GET .../info/refs?service=git-upload-pack` and `POST .../git-upload-pack` only; `git-receive-pack` always refused. Registries: `GET` and `HEAD` only. Only repos in the channel's project map.
- **Staging and companion hosts:** allowlisted by hostname through CONNECT, with no interception. See conflict C-001 for what that cannot do.
- **No credential helper** returns a token into the sandbox.
- **Staging test users: visible to the model.** Login forms need them. Mitigations: low-privilege accounts that exist only in staging, one set per project, rotated on a schedule (monthly proposed), and exact-match redaction of their values in all outputs. Injecting session cookies through the proxy is a possible later improvement.
- **TLS interception** is not used by default. It stays available for a specific tool that cannot be pointed at an HTTP route.

### D-003 Authorization model

**Proposal.**

- **Project map** in a config file in this repo (changes go through PR review). Each project lists: Slack channel ids, repos, Jira projects, staging hosts, companion domains, the approver Slack user group, and a `regulated` flag.
- **GitHub:** reads use the requester's own GitHub App user token, so the bot sees only what they can see. Phase 5 writes use the GitHub App installation token, limited to the mapped repos; the PR body names the requester and approver, and branch protection still applies.
- **Jira:** per-user OAuth for reads and writes, so comments are attributed to the person who asked.
- **Approvers:** members of the project's Slack user group, managed in Slack by the team lead.
- **Self-approval: not allowed** by default. A project can opt in for low-risk actions (such as Jira comments) if review turns out to be a bottleneck.
- **Channels:** projects with private repos are allowlisted only in private channels. Each post also checks that the requester can read the repo it quotes.

### D-004 Run semantics

**Proposal.**

- One BullMQ job per Slack event; a run state machine in Postgres: `queued → running → waiting_approval → completed | failed | interrupted | cancelled`.
- **Worker dies before the first tool call:** retry automatically, once.
- **Worker dies after a tool call:** do not replay; a rerun of an LLM loop can take different actions. Mark the run `interrupted`, edit the thread message to say where it stopped, and offer `retry`.
- **Side effects (Phase 5):** each carries an idempotency key `hash(run_id, step_id, payload)`, recorded before execution and checked by the connector layer.
- **Thread lock** in Redis, held through `waiting_approval`. New messages queue behind it; `stop` cancels the run and any pending approval.

### D-005 Slack transport in prod

**Proposal: Socket Mode in production.** This is an internal app: Socket Mode needs only an outbound WebSocket, so there is no public endpoint to expose or protect.

Trade-offs, from Slack's Socket Mode documentation (the docs site isn't reachable from the build workspace, so re-verify in Phase 1): Socket Mode apps can't be listed in the Slack Marketplace, and an app can hold a limited number of concurrent connections. Run at least two gateway replicas. The gateway stays transport-agnostic so HTTP can be switched in later.

### D-006 Sandbox runtime

**Proposal.**

- **gVisor (`runsc`) required in staging and production.** Dev may fall back to `runc`, with a warning logged at sandbox creation.
- **Phase 2 CI runs the escape tests under `runsc`.**
- **`/dev/shm`:** 1 GiB tmpfs, counted in the memory limit (proposed 4 GiB plus the 1 GiB for shm). `--ipc=host` is never used.
- **Chromium's own sandbox:** try it under `runsc` first. If it fails, fall back to `--no-sandbox`, recorded here as an amendment, on the grounds that the container is the security boundary and the browser only reaches allowlisted hosts.
- The build workspace has no gVisor and uses cgroup v1, so none of this was tested here. Phase 2 measures it on a host that matches production.

### D-007 Data handling

**Proposal:** as written in [data-handling.md](data-handling.md):

- the redaction rules;
- audit retention of 365 days for metadata and 90 days for content;
- 24-hour workspace volumes, pinned while a run waits for approval;
- for `regulated` projects, only ZDR-eligible API features. That means the Agent SDK over the Messages API, once the account team confirms it is covered. No Managed Agents, no Claude Tag, and no Covered Models unless Anthropic authorizes them.

### D-008 Warm start

**Proposal: a mix, all served through the egress proxy side, with no host mounts.**

- **Registry cache.** A caching registry for npm (and PyPI if needed) behind the proxy. Sandboxes read from it.
- **Git mirrors.** Bare mirrors of the mapped repos, refreshed on a schedule. A sandbox clones from the mirror, then fetches only the delta from origin.
- **Playwright browsers.** The Playwright download host sits behind the caching proxy, so `playwright install` for a repo's pinned version is a cache hit after the first time. The base image also pre-bakes the versions the mapped repos currently pin.
- **Per-repo prebuilt images** for the largest repos, only if Phase 2 measurements show they are needed.
- Phase 2 reports cold and warm hydration times before choosing further optimisations.

---

## Defaulted decisions

### D-009 TypeScript 6.0.3, not 7

TypeScript 7.0.2 is the latest release, but `typescript-eslint` 8.72 supports TypeScript `>=4.8.4 <6.1.0`. Moving to 7 waits for typescript-eslint support.

### D-010 Repo and package name `madar`

The user created `ijad-ai/madar`. The brief's layout root `chat-agent/` maps to this repo's root.

### D-011 `src/shared/` for logging and correlation ids

The brief's layout has no home for cross-cutting code. `src/shared/` holds the logger and correlation ids; other cross-cutting code joins it only when no layout folder fits.

### D-012 Image and action pinning

`redis:8.6-alpine`, `postgres:18-alpine`, `actions/checkout@v6`, `actions/setup-node@v6`, `pnpm/action-setup@v4`. The build workspace cannot reach Docker Hub or the GitHub API, so these tags were chosen from public release notes. The first CI run (PR #1) pulled every image and action successfully. Digest pins for images and SHA pins for actions are part of Phase 8 hardening.

### D-013 Local Postgres password default

The acceptance check requires `docker compose up -d` to work from a clean clone, without a `.env`. Compose therefore defaults `POSTGRES_PASSWORD` to `madar_local_dev`. The port binds to 127.0.0.1 only, and the value is not used anywhere real.

### D-014 TLS required by the production config

With `NODE_ENV=production`, config validation fails unless `REDIS_URL` uses `rediss://` and `DATABASE_URL` sets `sslmode` to `require`, `verify-ca` or `verify-full`. Fail closed rather than discover plaintext later.

### D-015 Redis 8

The brief specifies Redis. Redis 8 is offered under AGPLv3 among other licences. If your licensing review prefers a BSD licence, Valkey is a drop-in replacement for BullMQ's needs. Compose sets `maxmemory-policy noeviction` (BullMQ loses jobs under eviction) and AOF persistence.

### D-016 Node 22 and pnpm 10.28

`engines.node` is `>=22.12.0 <23` (pino 10 requires 22.12 or later). pnpm is pinned through `packageManager`. Dependencies are exact versions (`save-exact`).

## Defaulted in Phase 1

### D-017 Per-thread ordering on open-source BullMQ

BullMQ's job groups are a paid (Pro) feature. `src/queue/thread-scheduler.ts` adds what Phase 1 needs, in Redis with atomic Lua scripts. Each thread has:

- a pending set ordered by message timestamp;
- a lock owned by a job (not a worker), held as a lease that the running job renews;
- a stop request.

A job runs only when it is first in its thread and holds the lock; otherwise it is delayed briefly and tried again. A job restarted after a crash takes its own lock back at once. A pending entry whose job no longer exists is removed, so a thread can't stall. Phase 5 keeps the lock while a run waits for approval.

### D-018 One placeholder per request

The gateway posts a single `⏳` reply when it accepts a request. The worker never posts again: it edits that message with progress and then the outcome. This is what makes "exactly one outcome" hold across crashes and duplicate deliveries.

- **Progress marker.** Progress messages start with `⏳`; final messages never do. A run that was recorded as finished but whose placeholder still shows `⏳` was interrupted between the database write and the Slack edit. On redelivery the worker says so rather than guessing.
- **Narrow gap.** If the gateway's placeholder post fails, the worker posts one itself. A crash between that post and recording it can leave a second, stale placeholder. This only happens when Slack is already failing.

### D-019 Ids-only job payloads

Jobs in Redis carry Slack ids and timestamps only, never message text, as `data-handling.md` requires. The worker reads the thread with `conversations.replies` when the run starts, which also picks up messages that arrived while the job was queued.

### D-020 Claude API retries capped at 3

By default the SDK retries a failed API call 10 times with exponential backoff, even for a 401: more than a minute of waiting on a bad key. `CLAUDE_CODE_MAX_RETRIES` (from `AGENT_API_MAX_RETRIES`, default 3) caps it. Retries show in the thread as "the Claude API is busy". The wall-clock budget still bounds the whole run.

### D-021 No session persistence in Phase 1

Phase 1 has no approvals to resume after, so `persistSession` is off and each run's directories are deleted when it ends. This is stricter than D-001's note that sessions persist. Phase 5 turns persistence on, under the retention in `data-handling.md`.

### D-022 Token budget

`AGENT_MAX_TOKENS` counts input, output and cache tokens across all model calls in a run. It is enforced while the answer streams, so a runaway answer stops mid-way rather than after it finishes. `AGENT_MAX_COST_USD` is passed to the SDK as a second guard.

### D-023 Status for budget and timeout stops

The `runs.status` check allows `running`, `completed`, `failed`, `interrupted` and `cancelled`. A run stopped by a budget or the timeout is `failed`, and `outcome` says which limit (`budget_tokens`, `budget_turns`, `budget_cost`, `timeout`). The thread message shows any partial answer.

### D-024 Default model

`AGENT_MODEL` defaults to `claude-sonnet-5-5`, which balances quality and cost for conversational Phase 1 answers. Change it per deployment. Every run records the model it used.

### D-025 No gateway audit rows in Phase 1

The gateway does not use Postgres. Its decisions (duplicate, not enabled, rate limited, stop requested) are logged with the event id. Runs are audited by the worker, which refuses to run without the audit store. Revisit in Phase 5, when approval clicks arrive at the gateway.

### D-026 Scope of `stop`

The brief says `stop` cancels the current run. It also cancels every request queued before the stop message in that thread, because someone who says "stop" rarely wants the next queued request to start a second later. The running request ends as "Stopped by <name>"; queued ones end as "Cancelled by <name> before it started". Requests sent after the `stop` run normally.

### D-027 Slack output escaping

Everything the model writes is escaped (`&`, `<`, `>`) before it reaches Slack, in progress updates and final answers. That stops prompt-injected text from pinging `@channel`, mentioning people, or hiding a link behind a label. Posts also set `parse: none` and `link_names: false`. Content redaction (secrets, PII) is still Phase 3.

### D-028 Per-user rate limit

`RATE_LIMIT_PER_USER_PER_HOUR` defaults to 30 requests in a fixed one-hour window per user (threat T23). Help, stop and empty mentions don't count.

### D-029 The run processor decides restarts

BullMQ's `maxStalledCount` is 3, above the processor's own limit of 2 attempts (D-004). When a job comes back after a crash, the processor reads its audit record and decides: restart (attempt 2) or close it as interrupted (attempt 3, or any run that had already used a tool). If BullMQ does give up on a job, a `failed` listener closes the run and edits the placeholder.

### D-030 Append-only audit log

A trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` on `audit_events`. The 90- and 365-day retention purges (D-007) need a separate, audited maintenance path, which comes in Phase 8.

### D-031 Test seams

- `SLACK_API_URL` and `ANTHROPIC_BASE_URL` point the real WebClient and Agent SDK at local fakes in tests. `SLACK_API_URL` is refused when `NODE_ENV=production`.
- `ClaudeRunnerOptions.prepareRunDirs` lets a test plant files in a run's directories, which is how the T10 check works. Nothing sets it in production.

### D-032 Redis key prefix

`REDIS_KEY_PREFIX` (default `madar`) namespaces every Redis key: queue, thread scheduler, dedupe and rate limits. Environments can then share a Redis safely, and tests use unique prefixes.

---

## Conflicts with the brief

### C-001 Companion domains cannot be limited to GET without TLS interception

The brief asks for companion domains to be "limited to GET where possible". With D-002's default (no interception), the proxy sees only the hostname of a CONNECT tunnel, not the method. **Options:** accept hostname-only limits for staging and companion hosts (proposed), or intercept TLS for companion domains only. Interception would mean the browser must trust the proxy CA, which is more moving parts.

### C-002 The first 10 labeled triage failures need your CI history

The builder has no access to your historical CI failures, and fabricated examples would make the eval meaningless. Phase 0 ships the rubric, anonymization procedure, labeling workflow, record schema and a validator that runs in CI (`evals/triage/`). **Owner: your team.** Labeling 10 failures is the first step; the Phase 4 gate needs 50.

### C-003 Two "buy" options are excluded for regulated data

Claude Tag runs in the Team and Enterprise interfaces, and Managed Agents is not ZDR-eligible, so neither can handle regulated projects' data under ZDR. Details in [spike-build-vs-buy.md](spike-build-vs-buy.md).

### C-004 `docker compose up -d` could not run in the build workspace

The workspace's network policy blocks Docker Hub, so images could not be pulled. `docker compose config` validates, and the CI `compose` job runs `docker compose up --wait` and checks both services.

**Resolved 2026-10-25:** the `compose` job passed on PR #1, so the acceptance criterion is met in CI.

### C-005 The Slack demo can't run from the build workspace

The build workspace can't reach Slack and has no workspace tokens. Everything except the manual demo is covered by tests against a fake Slack Web API, the real WebClient and Bolt. **Owner: you.** [docs/slack-setup.md](slack-setup.md) is the setup guide and an eight-step demo script mapped to the acceptance criteria.

### C-006 Some Slack details are verified against packages, not Slack's docs

Slack's docs site isn't reachable from the build workspace. Bolt 5.1 and WebClient 8.2 type definitions and behaviour were used instead. Check these during the demo:

- Socket Mode's connection limits (D-005);
- `chat.update` rate limits (progress edits are throttled to one every 3 seconds per request, and skipped when rate-limited);
- how model answers render as `mrkdwn`.

### C-007 Signature verification applies to HTTP mode only

The brief's Phase 1 gateway verifies signatures. In Socket Mode (D-005, the default), Slack doesn't sign events: the WebSocket is opened with the app-level token instead. Signature and timestamp checks run in HTTP mode, which is tested with signed, forged and stale requests (`test/integration/gateway-http.test.ts`).

---

## Gate log

| Gate    | Date       | Result | Notes                                                                                                                                                              |
| ------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 0 | 2026-10-26 | Passed | Owner said "proceed" with no changes requested: D-001 to D-008 approved as proposed, C-001 (hostname-only limits for companion domains) accepted. Merged as PR #1. |
| Phase 1 | Pending    |        | Awaiting the Slack demo (C-005) and review of D-017 to D-032                                                                                                       |
