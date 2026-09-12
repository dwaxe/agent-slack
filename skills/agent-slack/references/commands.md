# `agent-slack` command map (reference)

Run `agent-slack --version` and `agent-slack <command> --help` before a write; installed help is authoritative.

Use this map for command discovery, not routine `message get` or `message list`.

## Contents

- [Auth](#auth)
- [Messages / threads](#messages--threads)
- [Thread subscriptions](#thread-subscriptions)
- [Channels](#channels)
- [Later](#later)
- [Unreads](#unreads)
- [Search](#search)
- [Canvas](#canvas)
- [Workflows](#workflows)
- [Users](#users)
- [User groups](#user-groups)

## Auth

- `agent-slack auth whoami` — show configured workspaces + token sources (secrets redacted)
- `agent-slack auth test [--workspace <url-or-unique-substring>]` — verify credentials (`auth.test`)
- `agent-slack auth import-desktop` — import browser-style creds from Slack Desktop (macOS/Windows)
- `agent-slack auth import-brave` — import creds from Brave (macOS; requires View → Developer → Allow JavaScript from Apple Events)
- `agent-slack auth import-chrome` — import creds from Chrome (macOS)
- `agent-slack auth import-firefox` — import creds from Firefox profile storage (macOS/Linux)
- `agent-slack auth parse-curl` — read a copied Slack cURL command from stdin and save creds
- `agent-slack auth add --workspace-url <url> [--token <xoxb/xoxp> | --xoxc <xoxc> --xoxd <xoxd>]`
- `agent-slack auth set-default <workspace-url>`
- `agent-slack auth remove <workspace-url>`

When local Linux auth must be repaired from an already authenticated macOS
Paseo target, also load `$paseo-cross-machine` and follow its
`references/agent-slack-auth.md` procedure. Do not copy the Mac's raw
`credentials.json`: browser credentials may be `__KEYCHAIN__` placeholders,
not portable secrets.

## Messages / threads

- `agent-slack message get <target>`
  - `<target>`: Slack message URL OR `#channel`/`channel`/channel id (`C...`) (see `targets.md`)
  - Options:
    - `--workspace <url-or-unique-substring>` (required when using a channel name or ID across multiple workspaces)
    - `--ts <seconds>.<micros>` (required when targeting a channel)
    - `--thread-ts <seconds>.<micros>` (optional hint for thread permalinks)
    - `--max-body-chars <n>` (default `8000`, `-1` unlimited)
    - `--include-reactions`
    - `--resolve-users` (attach resolved user profiles in `referenced_users`)
    - `--refresh-users` (implies `--resolve-users` and forces a cache refresh)

- `agent-slack message list <target>`
  - Lists recent channel messages (channel history), or fetches a full thread (root message plus replies)
  - **Channel history** (default when targeting a channel without `--thread-ts`):
    - `agent-slack message list "general"` — latest 25 messages
    - `agent-slack message list "general" --limit 50` — latest 50 messages
  - **Thread mode** (when `--thread-ts` or `--ts` is provided, or target is a message URL):
    - `agent-slack message list "<url>"` — root message plus all replies in that thread
    - `agent-slack message list "general" --thread-ts "1770165109.000001"` — root message plus replies
  - Options:
    - `--workspace <url-or-unique-substring>` (same rules as above)
    - `--thread-ts <seconds>.<micros>` (switches to thread mode; fetches replies)
    - `--ts <seconds>.<micros>` (resolve a message to its thread)
    - `--limit <n>` (default `25`, max `200`; channel history mode only)
    - `--oldest <ts>` (only messages after this ts; channel history mode)
    - `--latest <ts>` (only messages before this ts; channel history mode)
    - `--with-reaction <emoji>` (repeatable; include only messages that have this reaction; channel history mode; requires `--oldest`)
    - `--without-reaction <emoji>` (repeatable; include only messages that do not have this reaction; channel history mode; requires `--oldest`)
    - `--max-body-chars <n>` (default `8000`, `-1` unlimited)
    - `--include-reactions`
    - `--resolve-users` (attach resolved user profiles in `referenced_users`)
    - `--refresh-users` (implies `--resolve-users` and forces a cache refresh)

- `agent-slack message export-own --oldest <exact-ts> [--latest <exact-ts>]`
  - Exports the authenticated user's own top-level public/private-channel text in an exact inclusive window.
  - Excludes DMs/group DMs; does not hydrate messages, resolve users, or download files.
  - `--workspace <url-or-unique-substring>` pins one workspace; `--oldest` is required.

- `agent-slack message receipts list --workspace <full-url> --oldest <exact-ts> --latest <exact-ts>`
  - Lists local send/edit provenance without message plaintext for an exact inclusive window.
  - All three options are required. Reject `complete: false` before treating the result as a complete anti-join set.

- `agent-slack message compose <target> [text]`
  - Opens a send-capable rich editor in the browser; this is a mutation-capable command, not a draft-only action.
  - In CI, the editor is skipped and supplied text is sent immediately; safe mode blocks this shortcut.
  - Formatting toolbar: bold, italic, strikethrough, links, numbered/bulleted lists, quotes, inline code, code blocks.
  - Toggle between rich-text editing and raw mrkdwn source view.
  - After sending, shows a "View in Slack" permalink to the posted message.
  - If `<target>` is a Slack message URL, compose replies in that thread.
  - Options:
    - `--workspace <url-or-unique-substring>` (needed for channel names or IDs across multiple workspaces)
    - `--thread-ts <seconds>.<micros>` (optional, channel mode only)

- `agent-slack message draft list|create|update|delete`
  - Manages Slack-native unsent drafts that appear in the user's Slack client; requires browser auth.
  - `draft create` posts nothing.
  - `draft list [--limit <n>] [--all] [--workspace <selector>]`
  - `draft create <target> <text> [--thread-ts <ts>] [--broadcast] [--workspace <selector>]`
  - `draft update <id> <text> [--channel <target>] [--thread-ts <ts>] [--broadcast|--no-broadcast] [--last-updated-ts <ts>] [--workspace <selector>]`
  - `draft delete <id> [--last-updated-ts <ts>] [--workspace <selector>]`
  - Create accepts a message URL, channel, DM channel, or U/W user ID. Update can re-address a draft with `--channel`.

- `agent-slack message send <target> [text]`
  - If `<target>` is a Slack message URL, replies in that message’s thread.
  - Otherwise posts to the channel/DM.
  - `[text]` is optional when uploading files with `--attach`; when present, it becomes the initial comment on the first uploaded file.
  - Read `message-formatting.md` for conversion and rendering rules; read `mentions.md` before any notification.
  - Example: `agent-slack message send "general" "Coverage report" --attach ./report.md`
  - Options:
    - `--workspace <url-or-unique-substring>` (needed for channel names or IDs across multiple workspaces)
    - `--thread-ts <seconds>.<micros>` (optional, channel mode only)
    - `--attach <path>` (repeatable; upload local files as attachments)
    - `--blocks <path>` raw Block Kit blocks from a JSON file (or `-` for stdin). Bypasses markdown-to-rich-text conversion; enables header/divider/section/table blocks. Cannot be combined with `--attach`.
    - `--reply-broadcast` also posts a thread reply to the parent channel; requires thread context, is unsupported for DMs, and cannot be combined with `--attach`.
    - `--schedule <time>` schedules at a future ISO 8601 timestamp with explicit offset or Unix timestamp, within 120 days.
    - `--schedule-in <duration-or-phrase>` schedules within 120 days; named phrases use the CLI process's local timezone. Mutually exclusive with `--schedule`.
    - Scheduling cannot be combined with `--attach`; it works with thread replies and `--reply-broadcast`. Standard tokens call `chat.scheduleMessage` and return `Q...` IDs. Browser auth creates Slack-native scheduled drafts and returns `Dr...` IDs; `--blocks` must contain non-empty top-level `rich_text` blocks.

- `agent-slack message scheduled list [--channel <target>] [--oldest <unix-ts>] [--latest <unix-ts>] [--cursor <cursor>] [--limit <n>] [--workspace <selector>]`
  - Lists pending scheduled messages; `message scheduled` defaults to `list`. With browser auth, it reads at most 100 native drafts and returns `has_more: true` when Slack reports additional records; Slack exposes no cursor for the remainder, so `--cursor` is standard-token-only.

- `agent-slack message scheduled cancel <scheduled-message-id> --channel <target> [--workspace <selector>]`
  - Cancels one pending scheduled message. `--channel` is required and accepts a channel/DM name or ID.

- `agent-slack message edit <target> <text>`
  - URL target edits that exact message.
  - Channel target requires `--ts`.
  - Read `message-formatting.md`; read `mentions.md` before adding any notification.
  - Options:
    - `--workspace <url-or-unique-substring>` (needed for channel names or IDs across multiple workspaces)
    - `--ts <seconds>.<micros>` (required for channel targets)
    - `--blocks <path>` raw Block Kit blocks from JSON (or `-` for stdin), bypassing automatic conversion

- `agent-slack message delete <target>`
  - URL target deletes that exact message.
  - Channel target requires `--ts`.
  - Options:
    - `--workspace <url-or-unique-substring>` (needed for channel names or IDs across multiple workspaces)
    - `--ts <seconds>.<micros>` (required for channel targets)

- `agent-slack message react add <target> <emoji>`
- `agent-slack message react remove <target> <emoji>`
  - Options (channel mode):
    - `--workspace <url-or-unique-substring>` (needed for channel names or IDs across multiple workspaces)
    - `--ts <seconds>.<micros>` (required for channel targets)

## Thread subscriptions

- `agent-slack thread unsubscribe <message-url>`
  - Stops following one exact thread and verifies `subscribed: false`.
  - Requires an exact HTTPS Slack message permalink and browser-style auth; it uses an unsupported Slack session endpoint.
  - A root or reply URL is accepted. An already-unsubscribed thread is an idempotent success.

## Channels

- `agent-slack channel list [--workspace <url-or-unique-substring>] [--user <U...|@handle|handle> | --all] [--limit <n>] [--cursor <cursor>]`
  - Default mode calls `users.conversations` for the current user.
  - `--user` resolves handles/ids and lists conversations for that user.
  - `--all` switches to `conversations.list` (mutually exclusive with `--user`).
  - Returns one page and optional `next_cursor`; pass `--cursor` to continue.
- `agent-slack channel new --name <name> [--private] [--workspace <url-or-unique-substring>]`
- `agent-slack channel invite --channel <id|name> --users "<U...,@handle,email,...>" [--workspace <url-or-unique-substring>]`
  - Internal invite (default): resolves users (`U...`, `@handle`, `handle`, `email`) and uses `conversations.invite`
  - External invite: add `--external` (email targets only) to use `conversations.inviteShared`
  - Optional: `--allow-external-user-invites` sets `external_limited=false` for external invites
- `agent-slack channel mark <target> [--ts <seconds>.<micros>] [--workspace <url-or-unique-substring>]`
  - Marks a channel/DM as read up to the given message timestamp (`conversations.mark`)
  - URL target extracts channel, ts, and workspace automatically; `--ts` optionally overrides the URL timestamp; `--workspace` is rejected
  - Channel name/ID target requires `--ts`

## Later

- `agent-slack later list` — list saved-for-later messages (default: in-progress)
  - Options:
    - `--workspace <url-or-unique-substring>` (defaults to configured workspace)
    - `--state <state>` (filter: `in_progress` (default), `archived`, `completed`, `all`)
    - `--limit <n>` (max items, default `20`)
    - `--max-body-chars <n>` (max content chars per message, default `4000`, `-1` unlimited)
    - `--counts-only` (only show counts per state)

- `agent-slack later complete <target>` — mark a saved message as completed
- `agent-slack later archive <target>` — archive a saved message
- `agent-slack later reopen <target>` — move back to in-progress (from completed or archived)
- `agent-slack later save <target>` — save a message for later
- `agent-slack later remove <target>` — remove from Later entirely
  - All accept Slack message URL or channel ID with `--ts`
  - Options: `--workspace <url-or-unique-substring>`, `--ts <seconds>.<micros>`

- `agent-slack later remind <target> --in <duration>` — set a reminder on a saved item
  - `--in` accepts: `30m`, `1h`, `3h`, `2d`, `tomorrow`, `monday`, or a unix timestamp
  - Options: `--workspace <url-or-unique-substring>`, `--ts <seconds>.<micros>`

## Unreads

- `agent-slack unreads` — show all unread messages across channels, DMs, and threads
  - Options:
    - `--workspace <url-or-unique-substring>` (defaults to configured workspace)
    - `--counts-only` (only show unread counts, skip message content)
    - `--max-messages <n>` (max unread messages per channel, default `10`)
    - `--max-body-chars <n>` (max content chars per message, default `4000`, `-1` unlimited)
    - `--include-system` (include system messages like joins, leaves, topic changes; excluded by default)

## Search

- `agent-slack search all <query>` — messages + files (default)
- `agent-slack search messages <query>`
- `agent-slack search files <query>`

Common options:

- `--workspace <url-or-unique-substring>` (recommended when using channel names or IDs across multiple workspaces)
- `--channel <channel...>` repeatable (`#name`, `name`, or id)
- `--user <@name|name|U...>`
- `--after YYYY-MM-DD`
- `--before YYYY-MM-DD`
- `--content-type any|text|image|snippet|file`
- `--limit <n>` (default `20`)
- `--max-content-chars <n>` (default `4000`, `-1` unlimited; messages only)
- `--resolve-users` (attach resolved user profiles in `referenced_users`; applies to `search messages` / `search all`)
- `--refresh-users` (implies `--resolve-users` and forces a cache refresh)

## Canvas

- `agent-slack canvas create (--file <path> | --markdown <text>) [--title <title>] [--channel <id-or-name>]`
  - Exactly one Markdown source is required.
  - `--workspace <url-or-unique-substring>` selects the workspace.
  - Browser auth can create standalone canvases. `--channel` requires a standard token with `canvases:write`.

- `agent-slack canvas get <canvas-url-or-id>`
  - Options:
    - `--workspace <url-or-unique-substring>` (required when passing an id and multiple workspaces)
    - `--max-chars <n>` (default `20000`, `-1` unlimited)

## Workflows

- `agent-slack workflow list <channel> [--workspace <url-or-unique-substring>]` — list workflows bookmarked or featured in a channel
- `agent-slack workflow preview <trigger-id> [--workspace <url-or-unique-substring>]` — get workflow metadata from a trigger ID (no side effects)
- `agent-slack workflow get <id> [--workspace <url-or-unique-substring>]` — get workflow definition including form fields and steps (accepts `Ft...` or `Wf...`)
- `agent-slack workflow run <trigger-id> --channel <id-or-name> [--workspace <url-or-unique-substring>]` — trip a workflow trigger

## Users

- `agent-slack user list [--workspace <url-or-unique-substring>] [--limit <n>] [--cursor <cursor>] [--include-bots]`
- `agent-slack user get <U...|@handle|handle> [--workspace <url-or-unique-substring>] [--refresh] [--no-cache]`
- `agent-slack user resolve <identities...> [--workspace <url-or-unique-substring>]` — verify at most 20 canonical U/W IDs or emails through direct lookups; emits mentions only when every result is an active human
- `agent-slack user dm-open <users...> [--workspace <url-or-unique-substring>]` — get DM or group DM channel ID for one or more users (max 8)

## User groups

- `agent-slack usergroup get <S...|@handle|handle> [--workspace <url-or-unique-substring>]`
  - Gets one exact active or disabled group and never constructs a live mention.
- `agent-slack usergroup resolve <groups...> [--workspace <url-or-unique-substring>]`
  - Resolves exact IDs/handles from one complete directory snapshot and emits mention fields only when the entire active-group batch is safe.
