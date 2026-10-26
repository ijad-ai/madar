# authz

Who may invoke the bot, where, and against what (decision D-003).

- **Phase 1 (built):** `projects.ts` loads and validates `config/projects.json`. A mention in a channel that isn't in the map gets a short reply and nothing runs.
- **Phase 3:** repos and Jira projects per project; reads use the requester's own access.
- **Phase 5:** approver groups and the self-approval rule.
