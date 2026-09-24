---
name: agent-slack
description: Use for any Slack request or Slack URL, including reads, searches, drafts, files, reactions, and other Slack changes. Route all Slack access through agent-slack.
---

# agent-slack

Use `agent-slack` only for Slack API access. Before the first API call, pin one
workspace. When its URL is known, run `agent-slack auth check --workspace
<url>`; otherwise use `auth whoami` for discovery, then check the selected
workspace. If authentication is unavailable, stop and ask the user to
reauthenticate. Pure wording from user-provided context needs no Slack call.

## Contract

- Read and search freely. “Answer,” “reply,” or “respond” authorizes
  investigation and a draft, never posting.
- Every Slack state change requires an explicit request. Before a human-facing
  send or edit, show the exact workspace, target, action, and final
  Slack-visible content and obtain approval. Any target, visible content,
  resolved recipient, or payload change invalidates approval. `message compose`
  is a send.
- Render verified mentions readably for approval, but keep `<@U...>` and
  `<!subteam^S...>` markup internal unless requested.
- Prefer exact permalinks. Never combine evidence across workspaces or broaden
  DM/private evidence without authorization.
- Never scan the user directory to resolve a mention. Resolve the complete
  intended batch directly in one workspace: people by canonical ID or email;
  user groups by exact ID or handle. A tested workflow may use a checked-in
  `trusted_static` identity map. Use no partial batch.
- Safe mode redirects sends to drafts, blocks CI compose, and blocks edits and
  deletes.
- Do not mutate linked systems unless separately requested.
- Before a write, check `agent-slack --version` and run `agent-slack describe
<command path>` (or that command's `--help`). Afterward, verify the returned
  state as required by the relevant reference.

## Efficient paths

```bash
# One focal message plus its complete thread and a revalidation token
agent-slack message context "$SLACK_URL" --resolve-users

# Just before an approved write; unchanged output omits the thread body
agent-slack message revalidate "$SLACK_URL" --snapshot "$SNAPSHOT"

# Several bounded searches in one invocation; input is a JSON string array
agent-slack search batch queries.json --workspace "$WORKSPACE"

# Load one command contract, not the full catalog
agent-slack describe message send
```

Use `message get/list` only when their narrower or channel-history behavior is
actually needed. Deduplicate search queries before running them; hydrate only
the resulting exact permalinks that matter.

## Load only what the task needs

- [references/thread-investigation.md](references/thread-investigation.md):
  thread meaning, claim verification, drafting, and revalidation
- [references/message-formatting.md](references/message-formatting.md): links,
  lists, blocks, attachments, edits, and write verification
- [references/mentions.md](references/mentions.md): any notification
- [references/commands.md](references/commands.md): auth recovery and unusual
  command families
- [references/targets.md](references/targets.md): non-permalink targets and
  multi-workspace ambiguity
- [references/output.md](references/output.md): result guarantees, downloads,
  caches, schedules, drafts, and canvases
