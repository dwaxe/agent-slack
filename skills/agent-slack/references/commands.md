# `agent-slack` command map

Run `agent-slack --version` and `agent-slack <command> --help` before a write. Installed
help is authoritative. This reference documents non-obvious read and mutation contracts;
use command help for the full option inventory.

## Message reads

- `agent-slack message get <target>` fetches one message and optional thread summary.
- `agent-slack message list <target>` lists channel history or the full thread selected by
  a message URL, `--thread-ts`, or `--ts`.
  - `--include-mention-metadata` adds schema 2 `mention_evidence` to every message. In
    thread mode it also requires strict pagination and emits `thread_complete: true` only
    after the complete thread boundary and any reported root reply count are proven.
  - `--metadata-only` implies mention metadata, skips content rendering, file enrichment,
    and downloads, and emits `metadata_only: true`. Each message contains only `ts`,
    validated `author`, and `mention_evidence`; a proven thread also includes
    `thread_complete: true`.
  - Do not combine `--metadata-only` with `--include-reactions`, `--resolve-users`, or
    `--refresh-users`.
  - Channel-history mode is a bounded window and never emits `thread_complete`.

See [JSON output and downloads](output.md) for the exact evidence and completeness
contracts.

## Search

- `agent-slack search all <query>` searches messages and files.
- `agent-slack search messages <query>` searches messages.
  - `--require-complete-results` is global-search only. It validates Slack pagination and
    every message ref, then fails without partial output for malformed, unresolvable, or
    unfetchable results.
  - `--metadata-only` implies strict complete-result validation, skips full-message
    hydration and all file work, and emits `metadata_only: true`. Results contain only
    canonical `channel_id`, `ts`, and matching `permalink` fields.
  - `--metadata-only` cannot be combined with `--channel`, a non-`any` `--content-type`,
    `--resolve-users`, or `--refresh-users`.
- `agent-slack search files <query>` searches files.

`--metadata-only` is available only on `search messages`, not `search all` or
`search files`. See [JSON output and downloads](output.md) for its exact output shape.

## Thread subscriptions

- `agent-slack thread unsubscribe --expected-user-id <U...|W...> <message-url>` stops
  following one exact thread.
  - This is a mutation: require explicit user authorization before running it.
  - `<message-url>` must be an exact HTTPS Slack permalink for the thread root or a reply.
  - `--expected-user-id` is required and must be a canonical Slack `U...` or `W...` ID.
    Every credential attempt must match it through `auth.test` before subscription access.
  - Browser auth is required. The command also binds `auth.test` to the target workspace
    origin and team ID, verifies the workspace with `team.info`, and validates Enterprise
    Grid credentials when applicable before reading or mutating subscription state.
  - The command uses an unsupported Slack client endpoint and reads the subscription back
    after mutation. Treat success only according to the verified fields documented in
    [Thread subscription mutations](output.md#thread-subscription-mutations).
