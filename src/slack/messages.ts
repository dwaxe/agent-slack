import type { SlackMessageRef } from "./url.ts";
import type { SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";
import { enrichFiles, toSlackFileSummary, toSlackMessageSummary } from "./message-api-parsing.ts";
import {
  assertCanonicalThreadTimestamp,
  assertCompleteThreadReplyCount,
  assertCompleteThreadRoot,
  assertNewThreadCursor,
  parseCompleteThreadPage,
  readCompleteThreadRootReplyCount,
  validateCompleteThreadMessage,
} from "./thread-completeness.ts";

export type SlackFileSummary = {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  mode?: string;
  permalink?: string;
  url_private?: string;
  url_private_download?: string;
  size?: number;
  snippet?: {
    content?: string;
    language?: string;
  };
};

export type SlackMessageSummary = {
  channel_id: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  user?: string;
  bot_id?: string;
  text: string;
  markdown: string;
  mrkdwn?: unknown;
  blocks?: unknown;
  attachments?: unknown;
  files?: SlackFileSummary[];
  reactions?: unknown[];
};

export async function fetchMessage(
  client: SlackApiClient,
  input: {
    ref: SlackMessageRef;
    includeReactions?: boolean;
    includeFiles?: boolean;
    renderMarkdown?: boolean;
  },
): Promise<SlackMessageSummary> {
  const history = await client.api("conversations.history", {
    channel: input.ref.channel_id,
    latest: input.ref.message_ts,
    inclusive: true,
    limit: 5,
    include_all_metadata: input.includeReactions ? true : undefined,
  });
  const historyMessages = asArray(history.messages);
  let msg = historyMessages.find(
    (m): m is Record<string, unknown> => isRecord(m) && getString(m.ts) === input.ref.message_ts,
  );

  // Thread replies are not guaranteed to appear in channel history. If the URL
  // includes ?thread_ts=..., scan the thread directly.
  if (!msg && input.ref.thread_ts_hint) {
    msg = await findMessageInThread(client, {
      channelId: input.ref.channel_id,
      threadTs: input.ref.thread_ts_hint,
      targetTs: input.ref.message_ts,
      includeReactions: input.includeReactions,
    });
  }

  // Fallback: if the message_ts is actually the thread root, replies can still
  // be fetched via conversations.replies even if history is missing it.
  if (!msg) {
    try {
      const rootResp = await client.api("conversations.replies", {
        channel: input.ref.channel_id,
        ts: input.ref.message_ts,
        limit: 1,
        include_all_metadata: input.includeReactions ? true : undefined,
      });
      const [root] = asArray(rootResp.messages);
      if (isRecord(root) && getString(root.ts) === input.ref.message_ts) {
        msg = root;
      }
    } catch {
      // ignore
    }
  }

  if (!msg) {
    throw new Error("Message not found (no access or wrong URL)");
  }

  const enrichedFiles =
    input.includeFiles === false ? undefined : await parseAndEnrichFiles(client, msg.files);

  return toSlackMessageSummary({
    channelId: input.ref.channel_id,
    message: msg,
    fallbackTs: input.ref.message_ts,
    files: enrichedFiles,
    renderMarkdown: input.renderMarkdown,
  });
}

async function findMessageInThread(
  client: SlackApiClient,
  input: {
    channelId: string;
    threadTs: string;
    targetTs: string;
    includeReactions?: boolean;
  },
): Promise<Record<string, unknown> | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const resp = await client.api("conversations.replies", {
      channel: input.channelId,
      ts: input.threadTs,
      limit: 200,
      cursor,
      include_all_metadata: input.includeReactions ? true : undefined,
    });
    const messages = asArray(resp.messages);
    const found = messages.find(
      (m): m is Record<string, unknown> => isRecord(m) && getString(m.ts) === input.targetTs,
    );
    if (found) {
      return found;
    }
    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = meta ? getString(meta.next_cursor) : undefined;
    if (!next) {
      break;
    }
    cursor = next;
  }
  return undefined;
}

export async function fetchChannelHistory(
  client: SlackApiClient,
  input: {
    channelId: string;
    limit?: number;
    latest?: string;
    oldest?: string;
    includeReactions?: boolean;
    withReactions?: string[];
    withoutReactions?: string[];
    includeFiles?: boolean;
    renderMarkdown?: boolean;
  },
): Promise<SlackMessageSummary[]> {
  const raw = input.limit ?? 25;
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : 25;
  const out: SlackMessageSummary[] = [];
  const withReactions = input.withReactions ?? [];
  const withoutReactions = input.withoutReactions ?? [];
  const hasReactionFilters = withReactions.length > 0 || withoutReactions.length > 0;
  const pageLimit = hasReactionFilters ? 200 : limit;

  let cursorLatest = input.latest;
  for (;;) {
    const resp = await client.api("conversations.history", {
      channel: input.channelId,
      limit: pageLimit,
      latest: cursorLatest,
      oldest: input.oldest,
      include_all_metadata: input.includeReactions || hasReactionFilters ? true : undefined,
    });
    const messages = asArray(resp.messages);
    if (messages.length === 0) {
      break;
    }
    for (const m of messages) {
      if (!isRecord(m)) {
        continue;
      }
      if (
        hasReactionFilters &&
        !passesReactionNameFilters(m, {
          withReactions,
          withoutReactions,
        })
      ) {
        continue;
      }
      const enrichedFiles =
        input.includeFiles === false ? undefined : await parseAndEnrichFiles(client, m.files);

      out.push(
        toSlackMessageSummary({
          channelId: input.channelId,
          message: m,
          files: enrichedFiles,
          renderMarkdown: input.renderMarkdown,
        }),
      );
      if (out.length >= limit) {
        break;
      }
    }

    if (out.length >= limit || !hasReactionFilters) {
      break;
    }

    if (!resp.has_more) {
      break;
    }

    const last = messages.at(-1);
    const nextLatest = isRecord(last) ? getString(last.ts) : undefined;
    if (!nextLatest || nextLatest === cursorLatest) {
      break;
    }
    cursorLatest = nextLatest;
  }

  // conversations.history returns newest-first; normalize to chronological.
  out.sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
  return out;
}

export function passesReactionNameFilters(
  msg: Record<string, unknown>,
  input: { withReactions?: string[]; withoutReactions?: string[] },
): boolean {
  const withReactions = input.withReactions ?? [];
  const withoutReactions = input.withoutReactions ?? [];
  const names = new Set<string>();
  for (const r of asArray(msg.reactions)) {
    if (!isRecord(r)) {
      continue;
    }
    const name = getString(r.name)?.trim();
    if (name) {
      names.add(name);
    }
  }
  if (withReactions.some((name) => !names.has(name))) {
    return false;
  }
  if (withoutReactions.some((name) => names.has(name))) {
    return false;
  }
  return true;
}

export async function fetchThread(
  client: SlackApiClient,
  input: {
    channelId: string;
    threadTs: string;
    includeReactions?: boolean;
    requireComplete?: boolean;
    includeFiles?: boolean;
    renderMarkdown?: boolean;
  },
): Promise<SlackMessageSummary[]> {
  if (input.requireComplete) {
    assertCanonicalThreadTimestamp(input.threadTs);
  }

  const out: SlackMessageSummary[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const seenTimestamps = new Set<string>();
  let rootSeen = false;
  let reportedReplyCount: number | undefined;

  for (;;) {
    const resp = await client.api("conversations.replies", {
      channel: input.channelId,
      ts: input.threadTs,
      limit: 200,
      cursor,
      include_all_metadata: input.includeReactions ? true : undefined,
    });
    const page = input.requireComplete ? parseCompleteThreadPage(resp) : undefined;
    const messages = page?.messages ?? asArray(resp.messages);
    for (const m of messages) {
      if (!isRecord(m)) {
        continue;
      }
      if (input.requireComplete) {
        const isRoot = validateCompleteThreadMessage({
          message: m,
          threadTs: input.threadTs,
          seenTimestamps,
        });
        if (isRoot) {
          rootSeen = true;
          reportedReplyCount = readCompleteThreadRootReplyCount(m);
        }
      }
      const enrichedFiles =
        input.includeFiles === false ? undefined : await parseAndEnrichFiles(client, m.files);

      out.push(
        toSlackMessageSummary({
          channelId: input.channelId,
          message: m,
          files: enrichedFiles,
          renderMarkdown: input.renderMarkdown,
        }),
      );
    }
    const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
    const next = page?.nextCursor ?? (meta ? getString(meta.next_cursor) : undefined);
    if (!next) {
      break;
    }
    if (input.requireComplete) {
      assertNewThreadCursor(next, seenCursors);
    } else {
      seenCursors.add(next);
    }
    cursor = next;
  }

  if (input.requireComplete) {
    assertCompleteThreadRoot(rootSeen);
    assertCompleteThreadReplyCount({
      reported: reportedReplyCount,
      actual: seenTimestamps.size - 1,
    });
  }

  // Slack returns newest-first for some methods; normalize to chronological.
  out.sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
  return out;
}

async function parseAndEnrichFiles(
  client: SlackApiClient,
  rawFiles: unknown,
): Promise<SlackFileSummary[] | undefined> {
  const files = asArray(rawFiles)
    .map((file) => toSlackFileSummary(file))
    .filter((file): file is SlackFileSummary => file !== null);
  return files.length > 0 ? await enrichFiles(client, files) : undefined;
}

export { toCompactMessage, type CompactSlackMessage } from "./message-compact.ts";
