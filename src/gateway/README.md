# gateway

**Phase 1 (built).** Slack in and out.

| File                 | What it does                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `app.ts`             | The Bolt app: Socket Mode by default, HTTP with signature checks. Bolt acks each event before our listener runs.                           |
| `mention-handler.ts` | One @mention: dedupe, channel allowlist, `stop` and `help` answered at once, per-user rate limit, the single placeholder, an ids-only job. |
| `guards.ts`          | Event dedupe and the per-user hourly limit, in Redis.                                                                                      |
| `slack-api.ts`       | The Slack operations the bot uses, as a port over the WebClient.                                                                           |
| `slack-text.ts`      | Mention parsing, Slack-to-plain-text for the model, and escaping of model output.                                                          |
| `messages.ts`        | Every message the bot writes, in one place for review.                                                                                     |

The worker also uses `slack-api.ts`, `slack-text.ts` and `messages.ts` to edit placeholders.
