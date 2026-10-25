# Decisions

How to read this file:

- **Proposed** decisions are yours to approve at the Phase 0 gate (D-001 to D-008). Nothing is built on them until you do.
- **Defaulted** decisions were made during the build under working-agreement rule 5. Review them; change any you disagree with.
- **Conflicts** record where the brief turned out to be wrong or impossible (rule 9).
- Each phase gate is recorded at the bottom.

## Summary

| ID    | Decision                          | Status    | Proposal in one line                                                                    |
| ----- | --------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| D-001 | Runner placement                  | Proposed  | Runner outside the sandbox; built-ins off; repo never on the worker                     |
| D-002 | Credential model                  | Proposed  | URL rewriting for git and registries; staging users visible to the model, low-privilege |
| D-003 | Authorization model               | Proposed  | Project map in a reviewed config file; per-user reads; no self-approval                 |
| D-004 | Run semantics                     | Proposed  | Retry only before the first tool call; otherwise mark interrupted and ask               |
| D-005 | Slack transport in prod           | Proposed  | Socket Mode, no public ingress                                                          |
| D-006 | Sandbox runtime                   | Proposed  | gVisor required outside dev; 1 GiB `/dev/shm`; Chromium sandbox tried first             |
| D-007 | Data handling                     | Proposed  | Redaction rules, 365/90-day audit retention, ZDR path for regulated projects            |
| D-008 | Warm start                        | Proposed  | Registry cache + git mirrors + Playwright browser cache behind the proxy                |
| D-009 | TypeScript 6.0                    | Defaulted | typescript-eslint doesn't support TypeScript 7 yet                                      |
| D-010 | Repo and package name             | Defaulted | `madar`; the brief's `chat-agent/` root is this repo                                    |
| D-011 | `src/shared/` folder              | Defaulted | Logger and correlation ids live outside the brief's layout                              |
| D-012 | Image and action pinning          | Defaulted | Version tags now, digests and SHAs in Phase 8                                           |
| D-013 | Local Postgres password           | Defaulted | Local-only default so a clean clone starts                                              |
| D-014 | TLS required in production config | Defaulted | `rediss://` and `sslmode=require` or stricter                                           |
| D-015 | Redis 8                           | Defaulted | Matches the brief; Valkey is a drop-in if licensing prefers BSD                         |
| D-016 | Node and pnpm versions            | Defaulted | Node 22 (`>=22.12 <23`), pnpm 10.28                                                     |

---

## Proposed decisions

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
- `maxTurns` and `maxBudgetUsd` carry the per-run budgets; sessions persist to a per-run config dir so Phase 5 can resume them.

**Consequences.** Every tool call is an RPC to the sandbox, which adds a few milliseconds per call. The worker host becomes sensitive (it holds the API key) and must not run untrusted code.

**Note for legal review.** The Agent SDK is distributed under Anthropic's commercial terms, not an open-source licence.

**Test (Phase 1).** The tool list reported at session start contains only our tools. A planted `.claude/settings.json` in `cwd` has no effect.

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

---

## Gate log

| Gate    | Date    | Result | Notes                                                                         |
| ------- | ------- | ------ | ----------------------------------------------------------------------------- |
| Phase 0 | Pending |        | Awaiting review of the threat model, D-001 to D-008, the spike and the rubric |
