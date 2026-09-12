# Resolve Slack mentions

Add a live mention only when notification is intended and the exact payload is approved. Pin one canonical workspace. Treat people (`U...`/`W...`) and user groups (`S...`) separately.

For a draft-only or wording request, keep the user-supplied name as a readable placeholder. Resolve mentions immediately before presenting an API-ready payload for approval, unless the user explicitly asks for paste-ready mention markup earlier.

## People

Reuse an exact Slack ID only when a live direct lookup verified it in the pinned workspace during the current task. Cached `referenced_users`, `user get`, display names, and handles are useful for reading but do not verify a notification target.

Otherwise, pass every user-supplied canonical U/W ID or email to one direct batch:

```bash
agent-slack user resolve \
  U12345678 person@example.com \
  --workspace https://workspace.slack.com
```

The resolver accepts at most 20 identities, verifies the authenticated workspace, and uses `users.info` or `users.lookupByEmail`; it never calls `users.list`. It emits `<@ID>` tokens only when every input resolves to an active human.

Names and handles are not accepted by the safe resolver. If only a name or handle is available and no current-task result proves its ID, keep plain text or ask for the Slack ID/email. Never fall back to a directory scan, speculative aliases, or partial mention output.

## User groups

Reuse an exact `S...` group ID only when a live `usergroup resolve` call verified it in the pinned workspace during the current task. Otherwise pass every intended exact S ID or handle to one strict batch:

```bash
agent-slack usergroup resolve \
  @cloud-team S12345678 \
  --workspace https://workspace.slack.com
```

The resolver checks one complete `usergroups.list` snapshot. It emits `<!subteam^S...>` tokens only when every input resolves uniquely to an active group; missing, ambiguous, inactive, malformed, incomplete, or request-failed batches exit nonzero and contain no live mention token. `usergroup get` can inspect one active or disabled group but deliberately does not construct a mention.

Never scan messages or guess aliases to discover a group. Keep people and user-group batches separate, and use mention fields only when `safe_to_mention` is true.
