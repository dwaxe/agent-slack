# Investigate a Slack thread and draft an answer

## Anchor the conversation once

Prefer one exact permalink and run `message context --resolve-users`. It returns
the focal timestamp, complete chronological thread, latest timestamp, and a
snapshot bound to that workspace/message/content. Inspect only relevant
attachments, canvases, and nested links. If a specific gap needs search, bound
it by workspace, channel, participant, and date; use `search batch` for several
queries and hydrate only useful exact results.

Do not infer around inaccessible content, incomplete results, or failed
downloads.

## Define and verify the decision

Identify the focal question, audience, environment, time boundary, later
corrections, requested owner/action/deadline, and unknowns that could change the
answer. Treat Slack assertions as leads. Follow only primary sources needed to
settle the question: Jira/Confluence for requirements; code host for current
head/review/merge; CI for that head; rollout tools for live exposure; and code,
tests, files, or canvases for behavior.

Track material claims as fact, inference, or unknown with source and as-of time.
Prefer current authoritative state over older Slack text. Do not collapse
merged, built, deployed, Jira-done, or current-head-approved. A mention does not
prove ownership or consent. Read-only investigation does not authorize linked
system changes.

## Draft and revalidate

Lead with the answer, then the strongest evidence and one next action, owner, or
question. Match the thread's tone and avoid recapping known context. Read the
formatting reference for links/lists and the mentions reference before any
notification. Do not broaden DM/private evidence.

Show the exact target and payload for approval. Just before sending, run
`message revalidate <same-permalink> --snapshot <saved-snapshot>`. If it returns
`unchanged: true`, keep the approved payload. If it returns fresh context,
reassess; any meaningful change or equivalent answer requires a revised draft
and new approval. Then send once and verify the permalink and rendered result.
