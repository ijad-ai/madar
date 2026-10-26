# Slack setup and the Phase 1 demo

This gets Madar answering in a test Slack workspace from your machine, then walks through the Phase 1 gate demo. It takes about 15 minutes. You need Node 22, pnpm (`corepack enable`), Docker, a Slack workspace where you can create apps, and a Claude API key.

## 1. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From a manifest**, and pick your test workspace.
2. Paste the contents of [`slack/manifest.yaml`](../slack/manifest.yaml) and create the app.
3. **Basic Information → App-Level Tokens → Generate Token and Scopes.** Add the `connections:write` scope and generate. Copy the `xapp-…` token: this is `SLACK_APP_TOKEN`.
4. **Install App → Install to Workspace.** Copy the **Bot User OAuth Token** (`xoxb-…`): this is `SLACK_BOT_TOKEN`.

The app requests five scopes and subscribes to one event (`app_mention`). It has no public endpoint, because Socket Mode connects outward (decision D-005).

## 2. Pick a channel and add it to the project map

1. Create a test channel, for example `#madar-test`, and invite the bot: `/invite @madar`.
2. Open the channel's details. The channel id (`C…`) is at the bottom.
3. Add it to [`config/projects.json`](../config/projects.json):

   ```json
   { "projects": [{ "id": "demo", "name": "Demo", "slackChannels": ["C0123ABCD45"] }] }
   ```

   In a shared repo, make this change through a pull request (D-003).

## 3. Run it

```sh
cp .env.example .env
# Fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN and ANTHROPIC_API_KEY in .env
docker compose up -d --wait   # Redis and Postgres on 127.0.0.1
pnpm install
pnpm migrate
pnpm dev                      # gateway and worker in one process
```

Look for `Slack token verified` and `gateway listening for Slack events` in the output. Logs are JSON; pipe them through `npx pino-pretty` to read them more easily.

To run the gateway and worker as separate processes (needed for the crash demo below):

```sh
pnpm tsx src/main.ts gateway    # terminal 1
pnpm tsx src/main.ts worker     # terminal 2
```

## 4. The Phase 1 gate demo

Each step names the acceptance criterion it shows.

| #   | Do this                                                                                                                                      | Expect                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | In the mapped channel: `@madar what makes a Playwright test flaky?`                                                                          | A `⏳ Working on it…` reply in the thread, updating as the answer streams, then replaced by the answer. **Threaded reply.**                                   |
| 2   | In the same thread: `@madar and how would I find which ones are flaky?`                                                                      | The answer builds on the first one. **Follow-ups keep context.**                                                                                              |
| 3   | Start a long request (`@madar write a detailed 600-word guide to Playwright retries`), then immediately mention the bot again in that thread | The second reply says `⏳ Queued behind the current request…` and starts only after the first finishes. **Per-thread ordering.**                              |
| 4   | Start another long request, then `@madar stop` in its thread                                                                                 | "Stopping the current request…", and the running reply ends as `Stopped by <you>.` **Stop cancels the run.**                                                  |
| 5   | Mention the bot in a channel that is **not** in the project map (invite it there first)                                                      | A one-line "not enabled in this channel" reply, and nothing in the worker log. **Allowlist.**                                                                 |
| 6   | With separate processes: start a long request, then `kill -9` the worker while the reply shows `⏳`. Start the worker again.                 | The same reply changes to `⏳ Restarted after an interruption…`, then to the answer. There is still exactly one reply. **Exactly one outcome after a crash.** |
| 7   | Stop Postgres (`docker compose stop postgres`), then mention the bot                                                                         | "I can't take this request: the audit log is unavailable…". Start Postgres again afterwards. **Fail closed without the audit store.**                         |
| 8   | `@madar help`                                                                                                                                | Usage text, answered at once.                                                                                                                                 |

Then check the audit trail:

```sh
docker compose exec postgres psql -U madar -d madar -c \
  "select status, outcome, attempt, input_tokens, output_tokens, cost_usd from runs order by started_at desc limit 10;"
docker compose exec postgres psql -U madar -d madar -c \
  "select at, kind, actor from audit_events order by id desc limit 20;"
```

## Things to watch during the demo

Two Slack details come from the Bolt and WebClient packages rather than Slack's own docs, which weren't reachable from the build environment (decision C-006):

- **Formatting.** Answers are posted as plain `mrkdwn` text. Check that bold, code and lists render sensibly.
- **Rate limits.** Progress edits are throttled to one every 3 seconds per request, and skipped if Slack rate-limits them. If replies stall during step 3, note it.

## Troubleshooting

| Symptom                                                | Likely cause                                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid configuration: SLACK_APP_TOKEN: is required…` | `.env` is missing a token; every missing variable is listed.                                                                             |
| `database is not migrated`                             | Run `pnpm migrate`.                                                                                                                      |
| No reply at all                                        | The bot isn't in the channel, or the channel id isn't in `config/projects.json`. The worker logs a warning at start if the map is empty. |
| `not_authed` or `invalid_auth` at start                | The bot token is wrong or the app isn't installed.                                                                                       |
| Replies say the Claude API failed with status 401      | `ANTHROPIC_API_KEY` is wrong.                                                                                                            |
