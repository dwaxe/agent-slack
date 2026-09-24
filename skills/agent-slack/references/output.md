# Output guarantees and files

Slack data commands emit pruned JSON. Empty optional fields are usually absent;
authentication setup may emit text. Use command output as the schema and fail
closed when a required field below is absent.

## Deterministic reads

- `auth check` returns `ok`, canonical `workspace_url`, `team_id`, `user_id`,
  and `auth_type`.
- `message context` returns canonical workspace/channel/focal/thread/latest
  fields, `message_count`, `thread_complete: true`, chronological `messages`,
  and an opaque `snapshot`. It fails instead of returning a partial thread.
- `message revalidate` returns `unchanged: true` plus a replacement snapshot and
  boundaries when content is identical. On change it returns `unchanged: false`
  plus the fresh complete context. Attachment bodies are not downloaded unless
  `--download` is passed.
- `search batch` returns `metadata_only: true`, the normalized query list, and
  deduplicated exact message refs. Each ref has `matched_queries`, containing
  zero-based indexes into `queries`. It fails on malformed/incomplete results or
  when `--max-results` is exceeded.

`message get` returns one message and optional thread summary. `message list`
returns chronological messages; strict thread automation must require
`thread_complete: true`. `message export-own` is an exact inclusive,
schema-versioned, non-DM window; reject `complete: false`.

Use `--max-body-chars`, `--max-content-chars`, counts-only modes, and
metadata-only modes to bound output. Metadata-only message search returns only
verified `channel_id`, `ts`, and `permalink` and never hydrates bodies or files.

## Writes and special records

- Immediate sends return `channel_id` and, when Slack supplies them, `ts`,
  `thread_ts`, and `permalink`. Verify the resulting state.
- Scheduled sends return `scheduled_message_id` and `post_at`; standard-token
  IDs start `Q`, browser-auth native draft IDs start `Dr`.
- Browser-auth scheduled lists may return `has_more: true` without a cursor;
  treat that result as incomplete.
- Draft list returns `drafts` and `count`; create/update returns `draft`; delete
  returns `draft_id`.
- Thread unsubscribe succeeds only with `subscribed: false`, whether changed or
  already unsubscribed.
- Canvas create returns an ID; canvas get returns Markdown.

## Identities and caches

Message authors, reactions, and rendered mention tokens retain canonical IDs.
`referenced_users` adds display metadata only when resolution was requested.
Profile caching is workspace/credential-bound with per-entry expiry; never use
cached display fields to choose a write target.

`user resolve` emits live person mentions only when its complete active-human
batch is safe. `usergroup resolve` does the same from one complete active-group
snapshot. Any missing, ambiguous, inactive, malformed, or incomplete batch must
produce no live mention token.

## Attachments

Reads other than `message revalidate` download attachments by default to an agent temp directory and return
absolute `path` values. Failed message attachment downloads retain metadata,
`error`, and a `.download-error.txt` path. File-search failures may be skipped
with a warning, so absence is not proof no match exists; retry from the source
message when possible. Prefer message search with file content when a later
reply needs the source permalink/thread.

Use `--no-download` when metadata is enough. Never expose credentials or
presigned/private download URLs.
