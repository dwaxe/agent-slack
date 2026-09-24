# Command discovery and recovery

Do not load or maintain a static flag catalog. The installed CLI is
authoritative:

```bash
agent-slack describe <command path...> # compact JSON for one command
agent-slack <command path...> --help   # human-readable fallback
```

Top-level families are `auth`, `message`, `thread`, `channel`, `later`,
`unreads`, `search`, `canvas`, `workflow`, `user`, and `usergroup`. Run
`agent-slack --help` only when the family itself is unknown.

## Authentication

Use `auth check --workspace <url-or-unique-substring>` for routine readiness.
It returns only the resolved workspace, team, actor, and auth type. Use `auth
whoami` only to discover configured workspaces or token sources.

Recovery commands include `auth import-desktop`, browser imports, `parse-curl`,
`add`, `set-default`, and `remove`; inspect the selected command before use.
When local Linux auth must be repaired from an authenticated macOS Paseo
target, also load `$paseo-cross-machine` and follow its
`references/agent-slack-auth.md` procedure. Never copy the Mac's raw
`credentials.json`; it can contain non-portable Keychain placeholders.

## Non-obvious behavior

- `message compose` can send and CI skips its editor. Treat it as a mutation.
- `message draft` manages Slack-native unsent drafts and requires browser auth.
- Standard-token schedules return `Q...`; browser-auth native schedules return
  `Dr...` and accept only non-empty top-level `rich_text` blocks.
- `thread unsubscribe` requires an exact permalink, browser auth, and the
  verified expected actor.
- `workflow run` may execute downstream mutations.
- `user resolve` and `usergroup resolve` are the atomic mention-safe commands;
  diagnostic `get` commands do not authorize a mention.
- Canvas creation with a channel requires standard-token `canvases:write`.

For exact flags and constraints, use `describe`; do not infer them from this
summary.
