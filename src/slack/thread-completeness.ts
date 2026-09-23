import { getString, isRecord } from "../lib/object-type-guards.ts";
import { collectDirectMessageMentions } from "./message-mentions.ts";
import { isUserId } from "./user-id.ts";
import { isDeepStrictEqual } from "node:util";

const SLACK_MESSAGE_TS_PATTERN = /^\d+\.\d{6}$/;
const SLACK_BOT_ID_PATTERN = /^B[A-Z0-9]{8,}$/;
const COMPLETE_THREAD_ERROR_PREFIX = "Cannot prove complete thread mention metadata";

function completeThreadError(message: string): Error {
  return new Error(`${COMPLETE_THREAD_ERROR_PREFIX}: ${message}`);
}

export function assertCanonicalThreadTimestamp(threadTs: string): void {
  if (!SLACK_MESSAGE_TS_PATTERN.test(threadTs)) {
    throw completeThreadError("the requested thread timestamp is not canonical");
  }
}

export function parseCompleteThreadPage(response: Record<string, unknown>): {
  messages: Record<string, unknown>[];
  nextCursor?: string;
} {
  if (!Array.isArray(response.messages)) {
    throw completeThreadError("Slack returned a malformed messages page");
  }
  if (response.messages.some((message) => !isRecord(message) || Array.isArray(message))) {
    throw completeThreadError("Slack returned a non-object thread message");
  }
  if (typeof response.has_more !== "boolean") {
    throw completeThreadError("Slack omitted a boolean has_more pagination boundary");
  }

  const metadata = response.response_metadata;
  if (metadata !== undefined && (!isRecord(metadata) || Array.isArray(metadata))) {
    throw completeThreadError("Slack returned malformed response_metadata");
  }
  const rawNextCursor = isRecord(metadata) ? metadata.next_cursor : undefined;
  if (rawNextCursor !== undefined && typeof rawNextCursor !== "string") {
    throw completeThreadError("Slack returned a non-string next_cursor");
  }
  if (typeof rawNextCursor === "string" && rawNextCursor !== rawNextCursor.trim()) {
    throw completeThreadError("Slack returned a malformed next_cursor");
  }
  const nextCursor = rawNextCursor || undefined;
  if (response.has_more !== Boolean(nextCursor)) {
    throw completeThreadError("Slack returned inconsistent has_more and next_cursor values");
  }
  if (response.has_more && response.messages.length === 0) {
    throw completeThreadError("Slack returned an empty page before the thread boundary");
  }

  return {
    messages: response.messages as Record<string, unknown>[],
    nextCursor,
  };
}

export function validateCompleteThreadMessage(input: {
  message: Record<string, unknown>;
  threadTs: string;
  seenMessages: Map<string, Record<string, unknown>>;
}): "root" | "reply" | "duplicate_root" {
  if (input.message.text !== undefined && typeof input.message.text !== "string") {
    throw completeThreadError("Slack returned a message with malformed text");
  }
  if (
    input.message.user !== undefined &&
    (typeof input.message.user !== "string" || !isUserId(input.message.user))
  ) {
    throw completeThreadError("Slack returned a message without a canonical user ID");
  }
  if (
    input.message.bot_id !== undefined &&
    (typeof input.message.bot_id !== "string" || !SLACK_BOT_ID_PATTERN.test(input.message.bot_id))
  ) {
    throw completeThreadError("Slack returned a message without a canonical bot ID");
  }
  if (input.message.user === undefined && input.message.bot_id === undefined) {
    throw completeThreadError("Slack returned a message without a canonical author identity");
  }
  if (
    input.message.thread_ts !== undefined &&
    (typeof input.message.thread_ts !== "string" ||
      !SLACK_MESSAGE_TS_PATTERN.test(input.message.thread_ts))
  ) {
    throw completeThreadError("Slack returned a message with malformed thread_ts");
  }

  const ts = getString(input.message.ts);
  if (!ts || !SLACK_MESSAGE_TS_PATTERN.test(ts)) {
    throw completeThreadError("Slack returned a message without a canonical timestamp");
  }
  const messageThreadTs = getString(input.message.thread_ts);
  if (ts === input.threadTs) {
    if (messageThreadTs !== undefined && messageThreadTs !== input.threadTs) {
      throw completeThreadError("Slack returned the thread root with mismatched thread_ts");
    }
    const prior = input.seenMessages.get(ts);
    if (prior !== undefined) {
      if (!equivalentThreadRoots(prior, input.message)) {
        throw completeThreadError("Slack returned conflicting copies of the thread root");
      }
      return "duplicate_root";
    }
    input.seenMessages.set(ts, input.message);
    return "root";
  }
  if (input.seenMessages.has(ts)) {
    throw completeThreadError(`Slack returned duplicate message timestamp ${ts}`);
  }
  if (messageThreadTs !== input.threadTs) {
    throw completeThreadError("Slack returned a message outside the requested thread");
  }
  input.seenMessages.set(ts, input.message);
  return "reply";
}

function stableThreadRoot(message: Record<string, unknown>): Record<string, unknown> {
  const {
    last_read: _lastRead,
    latest_reply: _latestReply,
    reactions: _reactions,
    replies: _replies,
    reply_count: _replyCount,
    reply_users: _replyUsers,
    reply_users_count: _replyUsersCount,
    subscribed: _subscribed,
    unread_count: _unreadCount,
    unread_count_display: _unreadCountDisplay,
    ...stable
  } = message;
  return stable;
}

function equivalentThreadRoots(
  prior: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  const priorStable = stableThreadRoot(prior);
  const currentStable = stableThreadRoot(current);
  if (isDeepStrictEqual(priorStable, currentStable)) {
    return true;
  }
  const { blocks: _priorBlocks, ...priorWithoutBlocks } = priorStable;
  const { blocks: _currentBlocks, ...currentWithoutBlocks } = currentStable;
  if (!isDeepStrictEqual(priorWithoutBlocks, currentWithoutBlocks)) {
    return false;
  }
  const priorEvidence = collectDirectMessageMentions(prior);
  const currentEvidence = collectDirectMessageMentions(current);
  return (
    priorEvidence.complete &&
    currentEvidence.complete &&
    isDeepStrictEqual(priorEvidence, currentEvidence)
  );
}

export function readCompleteThreadRootReplyCount(
  message: Record<string, unknown>,
): number | undefined {
  const replyCount = message.reply_count;
  if (replyCount === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(replyCount) || Number(replyCount) < 0) {
    throw completeThreadError("Slack returned a malformed root reply_count");
  }
  return Number(replyCount);
}

export function assertCompleteThreadReplyCount(input: {
  reported: number | undefined;
  actual: number;
}): void {
  if (input.reported !== undefined && input.reported !== input.actual) {
    throw completeThreadError(
      `Slack returned ${String(input.actual)} replies but the root reports ${String(input.reported)}`,
    );
  }
}

export function assertNewThreadCursor(cursor: string, seenCursors: Set<string>): void {
  if (seenCursors.has(cursor)) {
    throw completeThreadError("Slack repeated a pagination cursor");
  }
  seenCursors.add(cursor);
}

export function assertCompleteThreadRoot(rootSeen: boolean): void {
  if (!rootSeen) {
    throw completeThreadError("Slack did not return the requested thread root");
  }
}
