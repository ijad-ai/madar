# Architecture

Status: **target architecture**, with Phase 1 built. Built now: config and logging (Phase 0); gateway, channel allowlist, queue, agent runner with no tools, run state and the basic audit log (Phase 1). Everything else lands in the phase named in the tables below. Decisions are in [decisions.md](decisions.md).

## The rule the design follows

The model can only ask. Writes and credentials are enforced at boundaries the model cannot argue its way past: the sandbox, the egress proxy, the connector layer and the approval gate. Parsing what the model writes (the command classifier) is an early warning, never the control.

## Topology

```mermaid
flowchart TD
  slack["Slack thread"] --> gw["Gateway: signature check, dedupe, channel allowlist"]
  gw --> q["Queue: one ordered job per thread"]
  q --> run["Agent runner: Agent SDK + Claude API, built-ins off, policy hooks, redaction"]
  run <-->|"Tier 2 request"| ap["Approval gate: approver group, single-use tokens"]
  run -->|"bash and files"| sb["Sandbox per thread: gVisor, non-root, internal network"]
  run -->|"MCP tool calls"| conn["Connector layer: token vault, per-user reads, channel map"]
  ap -.->|"approval token"| conn
  sb -->|"all traffic"| eg["Egress proxy: allowlist, scoped routes, credential injection, no git push"]
  eg --> ext["External: GitHub, Jira, registries, staging and UAT; production blocked"]
  conn -->|"API calls"| ext
  gw --> audit[("Audit log: append-only, Postgres")]
  q --> audit
  ap --> audit
```

## Components

| Component           | Code                             | Responsibility                                                               | Enforcement role                                                         | Phase                                 |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| Gateway             | `src/gateway/`                   | Slack events in, replies out; signature check, dedupe, 3-second ack, enqueue | Rejects forged or replayed requests; channel allowlist                   | **1 (built)**                         |
| Authorization       | `src/authz/`                     | Channel-to-project map, requester access, approver groups                    | Confused-deputy prevention                                               | **1 (channel allowlist built)**, 3, 5 |
| Queue               | `src/queue/`                     | BullMQ jobs, one run per thread, run state, thread lock                      | Ordering; no two runs touch one workspace                                | **1 (built)**, 5                      |
| Agent runner        | `src/agent/`                     | Agent SDK loop, budgets, progress messages                                   | Built-in tools off; budgets; redaction before the model                  | **1 (built, no tools)**               |
| Sandbox             | `src/sandbox/`, `sandbox-image/` | Per-thread container with shell, files and Playwright                        | Isolation: gVisor, non-root, no caps, read-only root, limits             | 2                                     |
| Egress proxy        | `src/egress/`                    | The sandbox's only route out                                                 | Allowlist, DNS, credential injection, route scoping, blocked-request log | 2, 3                                  |
| Connector layer     | `src/mcp/`                       | MCP servers for GitHub and Jira, token vault, trace scrubbing                | Tokens never leave it; writes need approval tokens                       | 3, 5                                  |
| Redaction           | `src/redaction/`                 | Secrets and PII out of tool output, audit rows and Slack posts               | Data-loss prevention                                                     | 3                                     |
| Policy              | `src/policy/`                    | Tier table and command classifier                                            | Early warning and UX only                                                | 5                                     |
| Approval gate       | `src/approvals/`                 | Block Kit approvals, single-use tokens, suspend and resume                   | Human-in-the-loop for Tier 2                                             | 5                                     |
| Audit               | `src/audit/`                     | Append-only record of every prompt, tool call, command, approval and cost    | Attribution; fail closed when unavailable                                | **1 (run rows built)**, 5             |
| QA skills           | `src/qa/`                        | Triage, test generation, healing, test data, release readiness               | Diff guard, assertion lint                                               | 4, 6                                  |
| Triggers and memory | `src/triggers/`, `src/memory/`   | Webhooks, schedules, kill switch, approved notes                             | Same tiers as human-triggered runs                                       | 7                                     |
| Config and logging  | `src/config/`, `src/shared/`     | Validated env, JSON logs with correlation ids                                | Secrets never in config errors or logs                                   | **0 (built)**                         |

## Request path

1. A user mentions the bot in an allowlisted channel. Bolt acknowledges the event before our code runs (and checks the signature in HTTP mode). The gateway drops duplicates by event id, answers `stop` and `help` at once, applies the per-user rate limit, posts the request's single `⏳` placeholder, and enqueues a job that carries ids only, keyed by `channel + thread_ts`. The Slack event id becomes the correlation id for every log line in the run.
2. The queue gives each thread one run at a time, in message order (D-017). A run waiting for approval keeps the thread lock but frees its worker (Phase 5).
3. The worker refuses to start a run it can't record in the audit log. It reads the thread from Slack, builds the prompt (the thread as JSON, each message tagged with its author, all of it untrusted) and runs the Agent SDK loop with only our registered tools: none in Phase 1. Progress edits the placeholder.
4. Tool calls go to the sandbox (shell and files) or the connector layer (GitHub and Jira). Their output is redacted before the model sees it.
5. The sandbox reaches the outside world only through the egress proxy. Credentialed routes (git fetch, registry reads) are plain HTTP to the proxy, which adds credentials upstream. Staging and companion hosts are allowlisted by hostname.
6. A Tier 2 action (PR, ticket, comment, shared test data) pauses the run and posts an approval rendered from the raw arguments. The approver's click mints a single-use token bound to that exact payload, and the connector layer refuses the write without it.
7. The outcome is recorded first, then written into the placeholder, escaped so it can't ping or mention anyone (redaction joins in Phase 3). If the audit store is down at either end, the run stops and says so.

## Where things live

| Process            | Runs                                                                            | Holds secrets                                                       |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Gateway            | Slack connection, approval button handling                                      | Slack signing secret, bot token                                     |
| Worker             | Queue consumer and agent runner (the Agent SDK subprocess runs here, per D-001) | Claude API key, Slack bot token (reads threads, edits placeholders) |
| Connector service  | MCP servers, token vault, trace scrubbing                                       | GitHub and Jira tokens                                              |
| Egress proxy       | Allowlist, credential injection, request log                                    | Git and registry credentials                                        |
| Sandbox containers | The agent's computer, one per thread                                            | **None**                                                            |
| Redis              | Queue and thread locks                                                          | None (job payloads hold ids, not content)                           |
| Postgres           | Audit log, run state, session metadata                                          | Audit content (redacted), encrypted at rest                         |

## Trust boundaries

Listed in [threat-model.md](threat-model.md#trust-boundaries). The two that carry the most weight: the sandbox boundary (everything inside it may be attacker-influenced) and the egress proxy (the only path from attacker-influenced code to the network).
