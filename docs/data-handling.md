# Data handling

Status: Phase 0 proposal (decision D-007). Retention periods are proposals for you and your security or legal reviewer to confirm.

## Principles

- Redact before data leaves its source boundary: before the model sees it, before it is written to the audit store, and before it is posted to Slack.
- Store references (ids, URLs) rather than content wherever that works.
- Staging uses masked or synthetic data. Projects that touch regulated data (for example health or payment data) are marked `regulated` in the project map and get the stricter rules below.

## Data inventory

| Data                                               | Source                          | Stored where                                 | Proposed retention                                                | Access                       | Redaction                                                              |
| -------------------------------------------------- | ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| Thread messages                                    | Slack                           | Not stored by us beyond audit rows           | Audit retention                                                   | Bot, audit readers           | Before audit write                                                     |
| Tool output (CI logs, file reads, command output)  | GitHub, sandbox                 | Workspace volume; audit rows (redacted text) | Volume TTL; audit retention                                       | Run only; audit readers      | Before model, audit, Slack                                             |
| Playwright traces and HAR files                    | GitHub artifacts                | Workspace, after scrubbing by the connector  | Volume TTL                                                        | Run only                     | Scrubbed outside the sandbox (Phase 3)                                 |
| Screenshots                                        | GitHub artifacts, agent runs    | Workspace                                    | Volume TTL                                                        | Run only                     | Masking for agent-taken shots; synthetic staging data                  |
| Videos                                             | GitHub artifacts, agent runs    | Workspace                                    | Volume TTL                                                        | Run only                     | Never sent to the model; posted only under the channel-visibility rule |
| Audit metadata (who, what, when, tier, cost)       | All components                  | Postgres                                     | 365 days                                                          | Security and platform owners | Not applicable (no content)                                            |
| Audit content (prompts, tool output, model output) | All components                  | Postgres                                     | 90 days                                                           | Security owners, by request  | Redacted before write                                                  |
| Run state and session transcripts                  | Worker                          | Postgres; per-run Agent SDK config dir       | Until run ends + 7 days                                           | Platform owners              | Redacted at source                                                     |
| Queue jobs                                         | Gateway                         | Redis                                        | Completed: removed; failed: 7 days                                | Platform owners              | Payloads hold ids only                                                 |
| Workspace volumes                                  | Sandbox                         | Docker volumes                               | Volume TTL (proposed 24 hours, pinned while waiting for approval) | Run only                     | n/a                                                                    |
| Approval records                                   | Approval gate                   | Postgres (audit)                             | Audit retention                                                   | Security owners              | Payload previews redacted                                              |
| Memory notes                                       | Agent proposals, human-approved | Postgres or repo files                       | Until deleted by a human                                          | Project members              | Reviewed by a human before storage                                     |
| Connector tokens                                   | OAuth                           | Vault, encrypted                             | Until revoked or rotated                                          | Connector service only       | Never logged                                                           |

## Redaction rules (Phase 3)

Replaced with `[REDACTED:<type>]`, so reviewers can see that something was removed and what kind.

| Type                     | What it matches                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault`                  | Exact match of any value held in the vault, including staging test passwords. Catches secrets no pattern would, such as `Summer2024`.                                                     |
| `token`                  | Known formats: GitHub (`ghp_`, `gho_`, `github_pat_`), Slack (`xox*`), Atlassian API tokens, AWS access keys, Google API keys, JWTs, `Bearer` and `Basic` credentials, private key blocks |
| `url-credential`         | Passwords inside URLs (`scheme://user:pass@host`)                                                                                                                                         |
| `cookie`                 | `Cookie` and `Set-Cookie` values                                                                                                                                                          |
| `entropy`                | High-entropy strings above a tuned threshold. Off for lockfiles and known hash fields, where it would break content; false-positive rate measured in Phase 3.                             |
| `email`, `phone`, `card` | Email addresses, phone numbers, card numbers passing the Luhn check                                                                                                                       |
| `custom`                 | Per-project patterns from the project map, such as member or account id formats                                                                                                           |

The logger's key-based redaction (`src/shared/logger.ts`) is a backstop for structured fields. It does not inspect free text.

## Binary artifacts

- **Traces and HAR files:** the connector unpacks them outside the sandbox, strips cookies, auth headers and sensitive response bodies from the network data, and runs the redactor over action logs and DOM snapshots (where typed form values are recorded).
- **Screenshots:** they skip text redaction and can carry injected text. Masking and synthetic data limit what they show; the security boundaries limit what an injected instruction can do.
- **Videos:** never sent to the model.

## Slack output

- Every post goes through redaction.
- Content from a private repo is posted only in a private channel mapped to that project, and only for a requester who can read the repo.
- Prefer links to artifacts over pasting their contents.

## Model provider terms (verified 2026-10-25)

From Anthropic's privacy center (last updated 2026-07-01) and the API data-retention page:

- **Default:** API inputs and outputs are deleted from Anthropic's backend within 30 days.
- **Exceptions:** content flagged for Usage Policy violations can be kept up to 2 years (classifier scores up to 7 years); data attached to feedback is kept 5 years; data may be kept where the law requires.
- **Zero Data Retention (ZDR)** is available by agreement and enabled per organization. Eligible: Messages API and prompt caching, among others. **Not eligible:** Batch API, Files API, Claude Managed Agents, the code execution tool, the MCP connector, and Claude Team or Enterprise interfaces (which includes Claude Tag).
- **Covered Models** (Claude Fable 5.x, Claude Mythos 5.x) require 30-day retention and are not available under ZDR unless Anthropic authorizes it.
- The retention page does not state whether the Agent SDK is ZDR-covered. It does say Claude Code used with API keys is covered, and the Agent SDK runs Claude Code under the hood. **Confirm with the account team before a regulated project goes live.**

Rules that follow, for `regulated` projects: use only ZDR-eligible features, do not use Covered Models unless authorized, and do not use Managed Agents or Claude Tag for that project's data.

## Deletion requests

Purging a thread deletes its workspace volume, run state and session transcripts, and replaces audit content with a tombstone that keeps the metadata. The runbook step lands in Phase 8.

## Sources

- [How long does Anthropic store my organization's data?](https://privacy.claude.com/en/articles/7996866-how-long-does-anthropic-store-my-organizations-data)
- [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
