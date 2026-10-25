# agent

**Phase 1.** The Claude Agent SDK runner: system prompt, thread history as context, per-run budgets (turns, tokens, wall-clock), and progress updates in Slack.

The SDK's built-in shell and file tools are disabled. A Phase 1 test asserts the tool list holds only the tools we register. Where the runner lives is decision D-001.

**Phase 2** adds the sandbox-backed tools; **Phase 5** wires the policy hooks.
