---
name: agent-slack
description: Use for any Slack request or Slack URL, including reads, searches, drafts, files, reactions, and other Slack changes. Route all Slack access through agent-slack.
---

# agent-slack

Use `agent-slack` only for Slack API access. Before the first API call, run
`agent-slack auth whoami`; if it is unavailable or unauthenticated, stop and
ask the user to reauthenticate. Pure wording based entirely on user-provided
context needs no Slack call.

## Core Contract

- Read and search freely. “Answer,” “reply,” or “respond” authorizes
  investigation and a draft, never posting.
- Every Slack state change requires an explicit request, including sends,
  uploads, edits, deletes, reactions, compose/draft/schedule actions, channel or
  DM changes, Later, canvases, thread subscriptions, and workflows. Workflow
  runs may execute downstream actions.
- Before a human-facing send or edit, show the exact workspace, target, action,
  and final payload and obtain approval. Any target or payload change invalidates
  that approval. Treat `message compose` as a send.
- Pin one workspace and prefer exact permalinks. Never combine message, search,
  channel, or identity evidence across workspaces or broaden DM/private evidence
  without authorization.
- Never scan the user directory to resolve a mention. Resolve each complete
  intended batch directly in one workspace: people by canonical ID or email,
  and user groups separately by exact ID or handle. Use returned mentions only
  when the whole batch is safe.
- With `AGENT_SLACK_SAFE_MODE=1` or `--safe-mode`, sends use the draft editor,
  CI compose is blocked, and edits and deletes are blocked.
- Do not mutate Jira, code review, CI, rollout, or another linked system unless
  separately requested.
- Before a write, check `agent-slack --version` and that command's installed
  `--help`. Afterward, verify the returned state as described in the relevant
  reference.
- Scheduling uses Slack's server-side feature: standard tokens call
  `chat.scheduleMessage`, while browser auth creates a native scheduled draft.
  Browser-auth schedules accept only non-empty top-level `rich_text` blocks.

## Quick Read

```bash
agent-slack message get "$SLACK_URL" --resolve-users
agent-slack message list "$SLACK_URL" --resolve-users
```

The first command identifies the focal message; the second returns its thread.

## Load Only What the Task Needs

- [references/thread-investigation.md](references/thread-investigation.md):
  thread meaning, claim verification, action advice, or reply drafting
- [references/message-formatting.md](references/message-formatting.md): links,
  lists, rich text, attachments, Block Kit, edits, and write verification
- [references/mentions.md](references/mentions.md): any person or user-group
  notification
- [references/commands.md](references/commands.md): authentication recovery,
  unfamiliar flags, and non-message features; skip for routine get/list
- [references/targets.md](references/targets.md): channel/timestamp targeting or
  multi-workspace ambiguity
- [references/output.md](references/output.md): exact JSON fields, receipts,
  scheduled/draft/canvas/thread results, caches, and downloads when unclear

Do not load every reference merely because a command returns JSON.
