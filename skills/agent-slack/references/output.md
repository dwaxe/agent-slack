# JSON output + downloads (reference)

## Output format

Slack data commands print JSON to stdout. Help, update, and some authentication setup commands print text instead.

- Empty values are pruned (`null`, `[]`, `{}` are removed where possible).
- `auth whoami` redacts secrets in its output.

## Message shapes (high-level)

- `message get` returns:
  - `message: { ... }`
  - `thread?: { ts, length }` (summary only; present when threaded)
  - `referenced_users?: { [user_id]: { id, name?, real_name?, display_name?, ... } }`

- `message list` returns:
  - `messages: [ ... ]` (chronological; the root plus all replies in thread mode)
  - `referenced_users?: { [user_id]: { id, name?, real_name?, display_name?, ... } }`
  - Messages are compact and omit redundant fields on each item where possible.

Compact readers preserve valid user-group and broadcast rich-text elements. Read `mentions.md` before constructing a live notification.

`message export-own` returns a schema-versioned, chronological window of the authenticated user's top-level text in public/private channels. Each message has Markdown `content`, an exact raw-text `content_sha256`, and a `canonical_content_sha256` that normalizes Slack URL autolinking, entities, mention labels, and standard emoji rewrites consistently with mutation receipts. `oldest` and `latest` are exact inclusive Slack timestamps. It excludes DMs/group DMs, verifies the author ID and workspace origin, deduplicates by `channel_id` + `ts`, and does not hydrate messages or files. Reject `complete: false`; it means the bounded search pagination cap was reached.

`message receipts list` returns schema-versioned local mutation provenance for an exact inclusive `oldest`/`latest` window with `tracking_started_at`, `unresolved_intent_count`, `incomplete_reasons`, and raw plus canonical content hashes, never message plaintext. `complete` requires coverage of the pre-window 120-day scheduling horizon, no in-window unresolved write-ahead intent, and a canonical hash for every timestamp-less receipt. Use `(channel_id, ts)` to exclude immediate sends/edits; use channel plus `canonical_content_sha256` only as a fallback when `ts` is absent.

- An immediate, non-attachment `message send` returns:
  - `ok: true`
  - `channel_id: "C..." | "D..."`
  - `ts?: "<seconds>.<micros>"` — the posted message's ts
  - `thread_ts?: "<seconds>.<micros>"` — present only when the send was into an existing thread
  - `permalink?: "https://.../archives/..."` — present when `ts` is known and a workspace URL was resolvable

Attachment sends return `channel_id`, and now also return `ts`/`thread_ts` when Slack supplies share metadata; do not assume an attachment send has a permalink. Scheduled sends return `scheduled_message_id` (`Q...` for standard tokens or `Dr...` for browser auth) and `post_at` instead of `ts`/`permalink`, plus `thread_ts` when applicable.

- `message scheduled list` returns `scheduled_messages: [ ... ]`, optional `next_cursor` for standard-token pagination, and optional `has_more: true` when a browser-auth native-draft result may be incomplete.
- `message scheduled cancel` returns `channel_id` and `scheduled_message_id`; local provenance-cleanup fields can also appear.
- `message draft list` returns `drafts: [ ... ]` and `count`. Create/update returns `draft`; delete returns `draft_id`. Draft destinations include channel/thread/broadcast metadata where present.
- `thread unsubscribe` returns `status: "unsubscribed"` after a verified change or `status: "already_unsubscribed"` after an idempotent no-op, plus canonical workspace/channel/thread metadata and the root permalink. Both success states report `subscribed: false`.
- `canvas create` returns `canvas: { id, title?, channel_id? }`. `canvas get` returns `canvas: { id, title?, markdown }`.

Message payload fields keep canonical user IDs (for example `author.user_id`, reaction `users[]`, and `@U...` mentions in rendered content). `referenced_users` provides display metadata for those IDs. The cache is tied to the active workspace credentials and has a 24-hour per-entry TTL. This behavior is opt-in and requires passing `--resolve-users` (or `--refresh-users` to replace cached entries before resolving). Never use cached profile fields to choose a mention or write target.

Exact-ID `user get` reuses the same cache. Pass `--refresh` to replace that entry or `--no-cache` to avoid reading or writing the cache.

- `user resolve <identities...>` performs live, uncached direct ID/email lookups and reports `lookups: { status, requests }` plus `safe_to_mention`; it emits `<@U...>` fields only when the entire active-human batch is safe. Otherwise it exits nonzero and emits no live mention token.

- `usergroup resolve <groups...>` checks one complete `usergroups.list` snapshot. It emits live `<!subteam^S...>` fields only when every exact ID/handle resolves uniquely to an active group. Missing, ambiguous, inactive, malformed, incomplete, or request-failed batches exit nonzero with no live mention token. `usergroup get` returns one exact active or inactive group without a mention field.

Use `--max-body-chars` to cap message bodies for token budget control.

## Later shape (high-level)

- `later list` returns:
  - `counts: { in_progress, archived, completed, total }`
  - `items: [{ channel_id, channel_name, ts, state, date_saved, message? }]`
  - `message` includes `author`, `content`, `thread_ts`, `reply_count`
  - Items sorted by most recently saved first
  - With `--counts-only`, `items` is omitted

- `later complete/archive/reopen/save/remove` returns `{ ok: true }`
- `later remind` returns `{ ok: true, remind_at }`

## Unreads shape (high-level)

- `unreads` returns:
  - `channels: [{ channel_id, channel_name, channel_type, unread_count, mention_count, messages? }]`
  - `threads?: { has_unreads, mention_count }` (present when there are unread thread replies)
  - `channel_type` is one of: `"channel"`, `"dm"`, `"mpim"`, `"group"`
  - Channels sorted by mention count (desc), then unread count (desc)
  - System messages (joins, leaves, topic changes) are excluded by default; use `--include-system` to include them
  - With `--counts-only`, `messages` is omitted

## Search shapes (high-level)

- `search messages|all` returns `messages: [ ... ]`
- `search messages|all` may include `referenced_users?: { [user_id]: { id, name?, real_name?, display_name?, ... } }`
- `search files|all` returns `files: [ ... ]`

Use `--max-content-chars` (messages) and `--limit` to control size.

## Channel shapes (high-level)

- `channel list` returns:
  - `channels: [ ... ]`
  - `next_cursor?: string` (present when more pages are available)

- `channel new` returns:
  - `channel: { id, name, is_private }`

- `channel invite` returns:
  - Internal invite mode:
    - `channel_id`
    - `invited_user_ids: [ ... ]`
    - `already_in_channel_user_ids?: [ ... ]`
    - `unresolved_users?: [ ... ]`
  - External invite mode (`--external`):
    - `channel_id`
    - `external: true`
    - `external_limited: boolean`
    - `invited_emails: [ ... ]`
    - `already_invited_emails?: [ ... ]`
    - `invalid_external_targets?: [ ... ]`

- `channel mark` returns:
  - `ok: boolean`
  - `channel: string` (resolved channel ID)
  - `ts: string`

## File fields in compact messages

When messages include file attachments, each file object contains:

- `name` — the original filename (e.g. `"report.pdf"`), omitted if unavailable
- `mimetype` — MIME type (e.g. `"application/pdf"`)
- `mode` — Slack file mode (e.g. `"hosted"`, `"snippet"`)
- `path` — absolute local path to the downloaded file

Files with a recorded download result are included: successful entries have a local `path`; failed entries keep metadata plus `error` and a `.download-error.txt` path as described below.

## Attachment downloads

Attachments are downloaded to an agent-friendly temp directory.

- Successful downloads are returned as absolute paths in output.
- `message get` preserves failed attachment downloads in `message.files[]`; `message list` uses `messages[].files[]`. Each failed entry has `error` and a `path` to a local `.download-error.txt` file.
- Message results from `search messages|all` preserve failed attachment downloads with `messages[].files[].error` and keep `messages[].files[].path` pointing to a local `.download-error.txt` file.
- `search files` warns and skips files whose download fails while continuing with remaining matches. A skip warning is not proof that no matching file exists; retry through its source message with `message get/list` when possible.
- For download-then-reply workflows, prefer `search messages --content-type file`: `search files` results have local paths but no source-message permalink or thread target.

Default download root:

- `~/.agent-slack/tmp/downloads/`

If `XDG_RUNTIME_DIR` is set, downloads live under:

- `$XDG_RUNTIME_DIR/agent-slack/tmp/downloads/`
