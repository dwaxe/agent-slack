# Investigate a Slack thread and draft an answer

## Anchor the live conversation

Prefer the exact permalink and one workspace. Use `message get --resolve-users` for the focal message and `message list --resolve-users` for the root plus every reply. Inspect only relevant attachments, canvases, and nested Slack links; refetch a truncated body only when needed. Record the latest reply timestamp. If a specific gap requires search, bound it by workspace, channel, participant, and date.

Do not infer around inaccessible content or failed downloads.

## Define the decision

Identify the focal question or decision, audience, system/environment, time boundary, later corrections, requested owner/action/deadline, and unknowns that could change the answer. Separate the live question from background discussion.

## Verify decision-relevant claims

Treat Slack assertions as leads. Follow only the primary sources needed to settle the question: Jira/Confluence for requirements and decisions; the code host for current diff, head, review, and merge state; CI for the exact current-head build; rollout tools for live exposure; repository code, tests, and history for behavior; and relevant files or canvases.

Track each material claim as `fact / inference / unknown`, with source and as-of time. Prefer current authoritative state over older Slack text and call out material conflicts. Do not collapse merged, built, deployed, Jira-done, or current-head-approved into the same status. Do not infer ownership or consent from a mention. State the target environment and as-of time for mutable status.

Read-only investigation does not authorize linked-system mutations.

## Draft the smallest useful answer

Lead with the answer, then only the strongest evidence and one next action, owner, or question. Distinguish inference when it matters. Match the thread’s tone and be terse; avoid recapping context participants know.

Read `message-formatting.md` when the draft contains links, lists, or rich formatting, and `mentions.md` before any notification. Do not move DM/private evidence to a broader audience without authorization; minimize sensitive detail.

If evidence is missing or contradictory, name the gap and qualify the draft.

## Revalidate before an approved send

Show the exact target and payload for approval. After approval, re-read the thread. If state changed or an equivalent answer appeared, revise and obtain approval again; otherwise send and verify the permalink and rendered result.
