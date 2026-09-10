# Slack targets

Prefer an exact message permalink:

```text
https://<workspace>.slack.com/archives/<channel_id>/p<digits>[?thread_ts=...]
```

It supplies the workspace, channel, and message timestamp. With a permalink:

- `message get`, `message edit`, `message delete`, and reactions operate on that exact message.
- `message list` returns the thread root plus replies.
- `message send`, `message compose`, and `message draft create` reply in that message's thread; explicit `--thread-ts` overrides URL-derived thread context for compose/drafts.
- `channel mark` marks through the URL timestamp; explicit `--ts` overrides it, and `--workspace` is rejected because the URL already supplies the workspace.
- `thread unsubscribe` derives the thread root and accepts only an exact HTTPS Slack message URL.

Without a permalink:

| Target                                 | Rule                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Channel name, such as `general`        | Pass `--workspace <full-url-or-unique-substring>` when multiple workspaces are configured.                                                |
| Channel ID (`C...`, `G...`, or `D...`) | Pass `--workspace` when multiple workspaces are configured.                                                                               |
| Point operation by channel             | Pass `--ts <seconds>.<micros>`.                                                                                                           |
| Full thread by channel                 | Pass `--thread-ts <root-ts>`, or `--ts <message-ts>` to resolve its thread.                                                               |
| User ID (`U...` or `W...`)             | `message send` and `message draft create` open/reuse a one-to-one DM. `message draft update --channel` can re-address a draft to that DM. |

Examples:

```bash
agent-slack message get "general" --ts "1770165109.628379" --workspace "myteam"
agent-slack message list "general" --thread-ts "1770165109.000001" --workspace "myteam"
agent-slack message edit "general" "updated text" --ts "1770165109.628379" --workspace "myteam"
```

Use `user dm-open <users...>` for one to eight other users to obtain a DM/group-DM channel ID, then use that channel ID for other message operations. The authenticated caller is implicit.

`SLACK_WORKSPACE_URL` accepts the same workspace selector. Non-URL channel, user, canvas, and workflow IDs do not carry workspace identity; use the intended default or pass `--workspace`. For command-specific exceptions, use installed `--help`.
