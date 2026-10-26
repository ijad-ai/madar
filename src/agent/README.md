# agent

**Phase 1 (built, no tools).**

| File               | What it does                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude-runner.ts` | Runs one request through the Claude Agent SDK, locked down per D-001: built-in tools off, no settings sources, empty per-run directories. Enforces the turn, token, cost and wall-clock budgets. |
| `sdk-env.ts`       | The subprocess environment: the API key, per-run directories and network settings, nothing else.                                                                                                 |
| `context.ts`       | The thread as JSON for the model, each message tagged with its author.                                                                                                                           |
| `system-prompt.ts` | The Phase 1 system prompt and its version.                                                                                                                                                       |
| `runner.ts`        | The `AgentRunner` interface and outcomes.                                                                                                                                                        |

The runner fails closed if the SDK ever reports a tool we didn't register.

**Phase 2** adds sandbox-backed tools as in-process MCP tools; **Phase 5** wires the policy hooks.
