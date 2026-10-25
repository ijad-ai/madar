# Spike: build or buy, for Phases 1–3

Date: 2026-10-25. Method: public Anthropic material and press coverage, plus the Agent SDK's own type definitions. No hands-on trial of either product, so treat the "unknowns" below as questions for the account team, not as missing features.

## Recommendation

**Build Phases 1–3 as planned on the Agent SDK. Don't build on Claude Tag now. Keep Managed Agents' self-hosted sandboxes as a candidate second `SandboxProvider`, and re-evaluate at the Phase 2 gate.**

The parts that make this product safe (the project map, per-user reads, approval tokens bound to payloads, route-scoped credential injection, the audit trail) are exactly the parts neither product exposes today. Both are also excluded from Zero Data Retention, which rules them out for regulated projects (conflict C-003).

## What each product offers

**Claude Tag** (beta for Team and Enterprise plans, launched 2026-06-23)

- Claude as a teammate in Slack: tag it, assign work, results come back in the thread.
- Admins choose which tools and data Claude can use per channel, set token spend limits per organization and per channel, and review a log of every action and who requested it.
- Separate Claude identities per team, with memory kept within each identity. An optional "ambient" mode follows up and flags things proactively. It replaces the earlier Claude in Slack app.
- **Unknown from public sources:** custom MCP servers or tools; per-action human approval; where code runs and how its network egress is controlled; self-hosting.
- **Data:** Team and Enterprise interfaces are not covered by ZDR.

**Claude Managed Agents** (public beta since 2026-04-08)

- Anthropic hosts the agent loop (orchestration, context management, error recovery), with sandboxed tool execution and sessions that persist across disconnections.
- **Self-hosted sandboxes** (public beta, 2026-05-19) run tool execution in your perimeter or on Cloudflare, Daytona, Modal or Vercel. Cloudflare and Vercel can inject credentials at the network boundary so they never enter the sandbox, which is the same idea as our D-002.
- **MCP tunnels** (research preview) reach private MCP servers through one outbound connection, with no inbound firewall rules.
- **Data:** not ZDR-eligible and not HIPAA-eligible; sessions persist until deleted.

## Fit against Phases 1–3

| Need                                                                | Claude Tag           | Managed Agents                          | Our build                                              |
| ------------------------------------------------------------------- | -------------------- | --------------------------------------- | ------------------------------------------------------ |
| Slack mentions, threads, progress (Phase 1)                         | Yes                  | No (bring your own gateway)             | Gateway + queue                                        |
| Channel allowlist, spend limits, action log                         | Yes (admin controls) | Partly (scoped permissions, tracing)    | `authz/`, budgets, audit                               |
| Repo-scoped per-user reads, channel-to-repo map                     | Unknown              | No                                      | D-003                                                  |
| Sandbox we control, egress allowlist, blocked-request log (Phase 2) | Unknown              | Yes, with self-hosted sandboxes         | Docker + gVisor + proxy                                |
| Credentials injected at the boundary, route scoping (Phase 3)       | Unknown              | Provider-dependent (Cloudflare, Vercel) | Egress proxy, D-002                                    |
| Approval tokens bound to payloads (Phase 5)                         | Not described        | Not described                           | `approvals/`                                           |
| ZDR for regulated projects                                          | No                   | No                                      | Yes, via the Messages API (confirm Agent SDK coverage) |

## Build or adopt, by component

| Component                                | Call                                  | Why                                                                                                                        |
| ---------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Gateway, authz, approvals, policy, audit | Build                                 | Our safety model lives here; neither product exposes it                                                                    |
| Agent loop                               | Build on the Agent SDK                | Keeps the ZDR path open; D-001 locks down built-ins and settings                                                           |
| Sandbox                                  | Build Docker + gVisor first           | A self-hosted Managed Agents sandbox (for example Vercel or Cloudflare) is the alternative to re-check at the Phase 2 gate |
| Egress and credential proxy              | Build                                 | Unless we move sandboxes to a provider whose firewall does the injection                                                   |
| Connectors                               | Build the registry                    | MCP tunnels are worth a look for private Jira or GitHub Enterprise Server later                                            |
| Claude Tag                               | Pilot separately for general team use | Revisit when custom tools and per-action approvals are confirmed                                                           |

## What `SandboxProvider` must support either way

- `create`, `exec` (with streamed output and a timeout), `readFile`, `writeFile`, `destroy`, `status`.
- **Labels** for attribution: thread, run and requester on every sandbox.
- **A workspace that outlives its compute**, so a run waiting for approval can stop the container and resume later with files intact.
- **An egress policy handle per sandbox** (allowlist in, blocked-request log out), whatever enforces it.
- **No credentials in the sandbox environment**, ever; credentialed access is a network-side concern.
- **Artifact export** (files out to the connector or Slack) without giving the sandbox network access to do it.
- Resource limits, a hard lifetime, and a reaper hook for orphans.

## Questions for the Anthropic account team

1. Can Claude Tag call organization-provided MCP servers or custom tools?
2. Does Claude Tag support per-action human approval, and can an approval be bound to an exact payload?
3. Where does Claude Tag execute code, and can an admin restrict its network egress to an allowlist?
4. Is traffic from the Agent SDK (Claude Code with an API key) covered by our ZDR agreement?
5. Is ZDR or HIPAA eligibility planned for Managed Agents or self-hosted sandboxes?

## Sources

- [Anthropic launches Claude Tag, bringing AI agents into Slack (TechRepublic)](https://www.techrepublic.com/article/news-anthropic-claude-tag-ai-agent-slack/)
- [Anthropic launches Claude Tag, replacing its Slack app (VentureBeat)](https://venturebeat.com/technology/anthropic-launches-claude-tag-replacing-its-slack-app-with-a-persistent-ai-teammate-that-learns-monitors-and-works-autonomously)
- [Anthropic rolls out Claude Managed Agents (InfoWorld)](https://www.infoworld.com/article/4156852/anthropic-rolls-out-claude-managed-agents.html)
- [New in Claude Managed Agents: self-hosted sandboxes and MCP tunnels (Anthropic)](https://claude.com/blog/claude-managed-agents-updates)
- [API and data retention (Anthropic)](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
- Agent SDK options: type definitions in `@anthropic-ai/claude-agent-sdk` 0.3.310 (`sdk.d.ts`)
