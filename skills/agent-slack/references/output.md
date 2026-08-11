# JSON output and downloads

Slack data commands print JSON to stdout. Help, update, and some authentication setup commands print text instead.

- Empty values are pruned (`null`, `[]`, `{}` are removed where possible).
- `auth whoami` redacts secrets in its output.

`message get` returns one message and an optional thread summary. `message list` returns chronological messages; in thread mode this includes the root and all replies.

`message export-own` returns a schema-versioned, chronological window of the authenticated user's top-level text in public/private channels. Each message has Markdown `content`, raw `content_sha256`, and `canonical_content_sha256`. The canonical hash normalizes Slack URL autolinking, entities, mention labels, and standard emoji rewrites consistently with mutation receipts. `oldest` and `latest` are exact inclusive Slack timestamps. It excludes DMs/group DMs, verifies the author ID and workspace origin, deduplicates by `channel_id` + `ts`, and does not hydrate messages or files. Reject `complete: false`; it means the bounded search pagination cap was reached.

`message receipts list` returns schema-versioned local mutation provenance for an exact inclusive `oldest`/`latest` window with `tracking_started_at`, `unresolved_intent_count`, `incomplete_reasons`, and raw/canonical content hashes, never message plaintext. `complete` requires coverage of the pre-window 120-day scheduling horizon, no in-window unresolved write-ahead intent, and a canonical hash for each timestamp-less receipt. Use `(channel_id, ts)` first; only when `ts` is absent, use `(channel_id, canonical_content_sha256)` as the fallback identity.

Immediate non-attachment sends return `ts` and usually a `permalink`. Attachment sends return `ts` when Slack supplies share metadata; scheduled sends return `scheduled_message_id` and `post_at` instead.

`canvas create` returns `canvas: { id, title?, channel_id? }`. `canvas get` returns `canvas: { id, title?, markdown }`.

Message payloads keep canonical user IDs. Pass `--resolve-users` to add display metadata under `referenced_users`, or `--refresh-users` to refresh the 24-hour per-workspace cache before resolving.

Use `--max-body-chars`, `--max-content-chars`, `--limit`, or a command's counts-only mode to keep results within the task's needs.

## Downloaded files

Message reads and searches download Slack files locally. Each successful file includes an absolute `path` plus available metadata such as `name`, `mimetype`, and `mode`.

- Successful downloads are returned as absolute paths in output.
- `message get` preserves failed downloads in `message.files[]`; `message list` uses `messages[].files[]`. Each failed entry has `error` and a `path` to a local `.download-error.txt` file.
- Message results from `search messages|all` preserve failed attachment downloads with `messages[].files[].error` and keep `messages[].files[].path` pointing to a local `.download-error.txt` file.
- `search files` warns and skips files whose download fails. Do not treat a skip warning as proof that no matching file exists; retry through the source message with `message get/list` when possible.
- For download-then-reply workflows, use `search messages --content-type file`: `search files` results include local paths but no source-message permalink or thread target.

Downloads use `$XDG_RUNTIME_DIR/agent-slack/tmp/downloads/` when `XDG_RUNTIME_DIR` is set; otherwise they use `~/.agent-slack/tmp/downloads/`.
