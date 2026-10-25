# mcp

**Phase 3.** Connector registry (config-driven MCP servers, per-tool allow and deny lists), OAuth and the token vault. Write tools are not registered until Phase 5.

Also owns trace scrubbing: Playwright `trace.zip` and HAR files are unpacked and scrubbed here, outside the sandbox, before they reach the workspace.
