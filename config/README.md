# config

`projects.json` is the project map (decision D-003). The bot answers only in the Slack channels listed here; a mention anywhere else gets a short reply and nothing runs. Change it through a pull request.

```json
{
  "projects": [
    {
      "id": "checkout",
      "name": "Checkout web",
      "slackChannels": ["C0123ABCD45"]
    }
  ]
}
```

- `id`: lowercase letters, digits and dashes.
- `slackChannels`: channel ids (right-click the channel, **View channel details**, the id is at the bottom). A channel belongs to one project only.
- Unknown keys are rejected, so a typo fails loudly instead of being ignored.

Later phases add repos, Jira projects, staging hosts, companion domains, the approver group and a `regulated` flag to each project.
