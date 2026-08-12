# JSON output and downloads

Slack data commands print JSON to stdout. Help, update, and some authentication setup commands print text instead.

- Empty values are pruned (`null`, `[]`, `{}` are removed where possible).
- `auth whoami` redacts secrets in its output.

`message get` returns one message and an optional thread summary. `message list` returns chronological messages; in thread mode this includes the root and all replies.

`message export-own` returns a schema-versioned, chronological window of the authenticated user's top-level text in public/private channels. Each message has Markdown `content`, raw `content_sha256`, and `canonical_content_sha256`. The canonical hash normalizes Slack URL autolinking, entities, mention labels, and standard emoji rewrites consistently with mutation receipts. `oldest` and `latest` are exact inclusive Slack timestamps. It excludes DMs/group DMs, verifies the author ID and workspace origin, deduplicates by `channel_id` + `ts`, and does not hydrate messages or files. Reject `complete: false`; it means the bounded search pagination cap was reached.

`message receipts list` returns schema-versioned local mutation provenance for an exact inclusive `oldest`/`latest` window with `tracking_started_at`, `unresolved_intent_count`, `incomplete_reasons`, and raw/canonical content hashes, never message plaintext. `complete` requires coverage of the pre-window 120-day scheduling horizon, no in-window unresolved write-ahead intent, and a canonical hash for each timestamp-less receipt. Use `(channel_id, ts)` first; only when `ts` is absent, use `(channel_id, canonical_content_sha256)` as the fallback identity.

`message list --include-mention-metadata` adds
`mention_evidence: { schema: 2, complete: boolean, user_ids: [...], usergroup_ids: [...] }`
to every listed message. Both ID arrays remain present when empty. Evidence covers only
direct mentions from mrkdwn-enabled top-level text, known semantic blocks, and explicitly
mrkdwn-enabled fields in normal legacy attachments. It excludes quoted, code, plain-text,
forwarded, and unfurled lookalikes. Unknown or unsupported message surfaces set
`complete: false`; mutation workflows must reject incomplete or unrecognized schemas.
Without the flag, this field is omitted. In thread mode, the command also emits exact
top-level `thread_complete: true` only after validating all cursor pages, message
timestamps, the requested root, and any reported root reply count; it fails without partial output if completeness cannot
be proven. Thread-driven mutations must require that exact field plus complete schema 2
evidence on every message. Channel-history mode never emits `thread_complete` because it
returns a bounded window rather than a complete collection.

`message list --metadata-only` emits exact top-level `metadata_only: true`, implies
mention evidence, and returns only `ts`, validated `author`, and `mention_evidence` for
each message. It scans raw mention-bearing surfaces before omitting content, skips file
enrichment and downloads, and still emits `thread_complete: true` only for a proven full
thread. It is incompatible with reaction inclusion and user-resolution options.

`search messages --require-complete-results` produces no partial result when Slack
returns a malformed or unresolvable match, lacks an exact matching permalink, or when a
matching message cannot be fetched.
It also requires coherent `page`, `pages`, and `total` pagination metadata and refuses
short result pages before `min(total, limit)` matches are collected. The option applies
only to global search and cannot be combined with `--channel`.

`search messages --metadata-only` emits exact top-level `metadata_only: true` and returns
only validated `channel_id`, `ts`, and `permalink` fields. It implies strict complete
results and does not hydrate messages, render content, enrich files, or download files.
It cannot be combined with channel fallback, content-type filtering, or user resolution.

Immediate non-attachment sends return `ts` and usually a `permalink`. Attachment sends return `ts` when Slack supplies share metadata; scheduled sends return `scheduled_message_id` and `post_at` instead.

## Thread subscription mutations

`thread unsubscribe` returns `status: "unsubscribed"` after a verified change or
`status: "already_unsubscribed"` after an idempotent no-op, plus the verified `user_id`,
canonical `workspace_url`, `channel_id`, `thread_ts`, and root `permalink`. Both successful
states report exact `subscribed: false`; require these verified output fields before
treating the mutation as successful.

`canvas create` returns `canvas: { id, title?, channel_id? }`. `canvas get` returns `canvas: { id, title?, markdown }`.

Message payloads keep canonical user IDs. Pass `--resolve-users` to add display metadata under `referenced_users`, or `--refresh-users` to refresh the 24-hour credential-scoped cache before resolving. Exact-ID `user get` reuses that cache; pass `--refresh` to replace one entry or `--no-cache` to bypass persistence. Never use cached profile fields to choose a mention or write target.

`user resolve` scans every returned workspace-directory page before finalizing exact active-human matches. Its output includes directory completeness and `safe_to_mention`. Live mention fields appear only when every requested identity resolves uniquely; otherwise the command exits nonzero and emits no live mention token. Incomplete evidence omits definitive per-input results.

`usergroup resolve` checks one complete `usergroups.list` snapshot and resolves exact active IDs or handles. Live `<!subteam^S…>` fields appear only when every requested group resolves uniquely; inactive, missing, ambiguous, malformed, or request-failed batches exit nonzero and contain no live mention token. `usergroup get` returns one exact active or inactive group without a mention field.

Use `--max-body-chars`, `--max-content-chars`, `--limit`, or a command's counts-only mode to keep results within the task's needs.

## Downloaded files

Message reads and searches download Slack files locally. Each successful file includes an absolute `path` plus available metadata such as `name`, `mimetype`, and `mode`.

- Successful downloads are returned as absolute paths in output.
- `message get` preserves failed downloads in `message.files[]`; `message list` uses `messages[].files[]`. Each failed entry has `error` and a `path` to a local `.download-error.txt` file.
- Message results from `search messages|all` preserve failed attachment downloads with `messages[].files[].error` and keep `messages[].files[].path` pointing to a local `.download-error.txt` file.
- `search files` warns and skips files whose download fails. Do not treat a skip warning as proof that no matching file exists; retry through the source message with `message get/list` when possible.
- For download-then-reply workflows, use `search messages --content-type file`: `search files` results include local paths but no source-message permalink or thread target.

Downloads use `$XDG_RUNTIME_DIR/agent-slack/tmp/downloads/` when `XDG_RUNTIME_DIR` is set; otherwise they use `~/.agent-slack/tmp/downloads/`.
