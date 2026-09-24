import { createHash } from "node:crypto";
import type { CliContext } from "./context.ts";
import { downloadMessageFiles } from "./message-file-downloads.ts";
import { toThreadListMessage } from "./message-thread-info.ts";
import { warnOnTruncatedSlackUrl } from "./message-url-warning.ts";
import { parseMsgTarget } from "./targets.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { isRecord } from "../lib/object-type-guards.ts";
import { fetchThread, toCompactMessage } from "../slack/messages.ts";
import { compactReactions } from "../slack/message-compact.ts";
import { renderSlackMessageContent } from "../slack/render.ts";
import {
  collectReferencedUserIds,
  resolveUsersById,
  toReferencedUsers,
} from "../slack/user-cache.ts";

const SNAPSHOT_PREFIX = "v1.";
const CANONICAL_MESSAGE_TS = /^\d+\.\d{6}$/;
const CANONICAL_CHANNEL_ID = /^[CDG][A-Z0-9]{8,}$/;

export type MessageContextOptions = {
  maxBodyChars: string;
  download?: boolean;
  includeReactions?: boolean;
  resolveUsers?: boolean;
  refreshUsers?: boolean;
};

type SnapshotClaims = {
  workspace_url: string;
  channel_id: string;
  focal_ts: string;
  thread_ts: string;
  latest_ts: string;
  message_count: number;
  include_reactions: boolean;
  digest: string;
};

function stableThreadDigest(messages: Awaited<ReturnType<typeof fetchThread>>): string {
  const stable = messages.map((message) => ({
    ts: message.ts,
    author: { user_id: message.user, bot_id: message.bot_id },
    content: renderSlackMessageContent(message),
    files: (message.files ?? []).map((file) => ({
      id: file.id,
      name: file.name,
      mimetype: file.mimetype,
      mode: file.mode,
    })),
    reactions: (compactReactions(message.reactions) ?? [])
      .map((reaction) => ({
        ...reaction,
        users: [...reaction.users].sort(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  }));
  return createHash("sha256").update(JSON.stringify(stable), "utf8").digest("hex");
}

function encodeSnapshot(claims: SnapshotClaims): string {
  return `${SNAPSHOT_PREFIX}${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}`;
}

function parseMaxBodyChars(raw: string): number {
  if (!/^(?:-1|\d+)$/.test(raw)) {
    throw new Error("--max-body-chars must be -1 or a non-negative integer");
  }
  return Number.parseInt(raw, 10);
}

export function parseContextSnapshot(snapshot: string): SnapshotClaims {
  if (!snapshot.startsWith(SNAPSHOT_PREFIX)) {
    throw new Error("Invalid context snapshot version");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(snapshot.slice(SNAPSHOT_PREFIX.length), "base64url").toString(),
    );
  } catch {
    throw new Error("Invalid context snapshot encoding");
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid context snapshot payload");
  }
  const claims = parsed as Partial<SnapshotClaims>;
  if (
    typeof claims.workspace_url !== "string" ||
    typeof claims.channel_id !== "string" ||
    !CANONICAL_CHANNEL_ID.test(claims.channel_id) ||
    typeof claims.focal_ts !== "string" ||
    !CANONICAL_MESSAGE_TS.test(claims.focal_ts) ||
    typeof claims.thread_ts !== "string" ||
    !CANONICAL_MESSAGE_TS.test(claims.thread_ts) ||
    typeof claims.latest_ts !== "string" ||
    !CANONICAL_MESSAGE_TS.test(claims.latest_ts) ||
    typeof claims.message_count !== "number" ||
    !Number.isInteger(claims.message_count) ||
    claims.message_count < 1 ||
    typeof claims.include_reactions !== "boolean" ||
    typeof claims.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(claims.digest)
  ) {
    throw new Error("Invalid context snapshot claims");
  }
  let workspaceUrl: string;
  try {
    workspaceUrl = new URL(claims.workspace_url).origin;
  } catch {
    throw new Error("Invalid context snapshot workspace");
  }
  return { ...(claims as SnapshotClaims), workspace_url: workspaceUrl };
}

export async function handleMessageContext(input: {
  ctx: CliContext;
  targetInput: string;
  options: MessageContextOptions;
}): Promise<Record<string, unknown>> {
  const target = parseMsgTarget(input.targetInput);
  if (target.kind !== "url") {
    throw new Error("message context requires an exact Slack message permalink");
  }
  warnOnTruncatedSlackUrl(target.ref);
  const includeReactions = Boolean(input.options.includeReactions);
  const download = input.options.download !== false;
  const maxBodyChars = parseMaxBodyChars(input.options.maxBodyChars);

  return await input.ctx.withAutoRefresh({
    workspaceUrl: target.ref.workspace_url,
    work: async () => {
      const { client, auth, workspace_url } = await input.ctx.getClientForWorkspace(
        target.ref.workspace_url,
      );
      const threadTs = target.ref.thread_ts_hint ?? target.ref.message_ts;
      const threadMessages = await fetchThread(client, {
        channelId: target.ref.channel_id,
        threadTs,
        includeReactions,
        requireComplete: true,
        fetchFileInfo: download,
      });
      if (!threadMessages.some((message) => message.ts === target.ref.message_ts)) {
        throw new Error("Complete thread context did not contain the focal message");
      }
      const downloadedPaths = await downloadMessageFiles({
        auth,
        messages: threadMessages,
        download,
      });
      const referencedUserIds = collectReferencedUserIds(threadMessages, { includeReactions });
      const usersById =
        input.options.resolveUsers || input.options.refreshUsers
          ? await resolveUsersById({
              client,
              workspaceUrl: workspace_url ?? target.ref.workspace_url,
              userIds: referencedUserIds,
              forceRefresh: Boolean(input.options.refreshUsers),
            })
          : new Map();
      const messages = threadMessages.map((message) =>
        toThreadListMessage(
          toCompactMessage(message, {
            maxBodyChars,
            includeReactions,
            downloadedPaths,
            includeUndownloadedFileMetadata: !download,
          }),
        ),
      );
      const latestTs = threadMessages.at(-1)?.ts;
      if (!latestTs) {
        throw new Error("Slack returned an empty thread context");
      }
      const claims: SnapshotClaims = {
        workspace_url: new URL(workspace_url ?? target.ref.workspace_url).origin,
        channel_id: target.ref.channel_id,
        focal_ts: target.ref.message_ts,
        thread_ts: threadTs,
        latest_ts: latestTs,
        message_count: threadMessages.length,
        include_reactions: includeReactions,
        digest: stableThreadDigest(threadMessages),
      };
      return pruneEmpty({
        workspace_url: claims.workspace_url,
        channel_id: claims.channel_id,
        focal_ts: claims.focal_ts,
        thread_ts: claims.thread_ts,
        latest_ts: claims.latest_ts,
        message_count: claims.message_count,
        include_reactions: claims.include_reactions,
        thread_complete: true,
        snapshot: encodeSnapshot(claims),
        messages,
        referenced_users: toReferencedUsers(referencedUserIds, usersById),
      }) as Record<string, unknown>;
    },
  });
}

export async function handleMessageRevalidate(input: {
  ctx: CliContext;
  targetInput: string;
  snapshot: string;
  options: MessageContextOptions;
}): Promise<Record<string, unknown>> {
  const previous = parseContextSnapshot(input.snapshot);
  const target = parseMsgTarget(input.targetInput);
  if (target.kind !== "url") {
    throw new Error("message revalidate requires an exact Slack message permalink");
  }
  if (
    new URL(target.ref.workspace_url).origin !== previous.workspace_url ||
    target.ref.channel_id !== previous.channel_id ||
    target.ref.message_ts !== previous.focal_ts
  ) {
    throw new Error("Context snapshot does not belong to the requested Slack message");
  }

  const current = await handleMessageContext({
    ctx: input.ctx,
    targetInput: input.targetInput,
    options: {
      ...input.options,
      download: input.options.download === true,
      includeReactions: previous.include_reactions,
    },
  });
  const currentSnapshot = current.snapshot;
  if (typeof currentSnapshot !== "string") {
    throw new Error("Current Slack context did not produce a snapshot");
  }
  const currentClaims = parseContextSnapshot(currentSnapshot);
  if (currentClaims.thread_ts !== previous.thread_ts) {
    throw new Error("Slack message resolved to a different thread than the saved snapshot");
  }
  if (currentClaims.digest === previous.digest) {
    return {
      unchanged: true,
      snapshot: currentSnapshot,
      thread_ts: currentClaims.thread_ts,
      latest_ts: currentClaims.latest_ts,
      message_count: currentClaims.message_count,
    };
  }
  return { unchanged: false, ...current };
}
