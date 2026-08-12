import type { SlackApiClient, SlackAuth } from "./client.ts";
import type { CompactSlackMessage, SlackMessageSummary } from "./messages.ts";
import { fetchMessage, toCompactMessage } from "./messages.ts";
import { resolveChannelId } from "./channels.ts";
import { ensureDownloadsDir } from "../lib/tmp-paths.ts";
import { type DownloadResult, tryDownloadSlackFile, writeDownloadErrorFile } from "./files.ts";
import { renderSlackMessageContent } from "./render.ts";
import { parseSlackMessageUrl } from "./url.ts";
import { inferExt } from "./search-file-ext.ts";
import { dateToUnixSeconds, resolveUserId } from "./search-query.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";
import { collectReferencedUserIds, resolveUsersById, toReferencedUsers } from "./user-cache.ts";
import type { CompactSlackUser } from "./users.ts";
import { toSlackFileSummary, toSlackMessageSummary } from "./message-api-parsing.ts";

export type ContentType = "any" | "text" | "image" | "snippet" | "file";
export type SearchMessageResult = {
  messages: SearchCompactMessage[];
  referenced_users?: Record<string, CompactSlackUser>;
};

export async function searchMessagesViaSearchApi(
  client: SlackApiClient,
  input: {
    auth: SlackAuth;
    workspace_url?: string;
    slack_query: string;
    limit: number;
    maxContentChars: number;
    contentType: ContentType;
    download: boolean;
    rawMatches: Record<string, unknown>[];
    resolveUsers?: boolean;
    refreshUsers?: boolean;
    requireCompleteResults?: boolean;
  },
): Promise<SearchMessageResult> {
  const matches = input.rawMatches;
  if (matches.length === 0) {
    return { messages: [] };
  }

  const messageRefs: {
    channel_id: string;
    message_ts: string;
    permalink?: string;
  }[] = [];
  for (const m of matches) {
    const ts = getString(m.ts)?.trim() ?? "";
    if (!ts) {
      if (input.requireCompleteResults) {
        throw new Error(
          "Slack search returned a message without a timestamp; refusing partial output",
        );
      }
      continue;
    }
    const channelValue = isRecord(m.channel) ? m.channel : null;
    const rawChannelId = channelValue ? getString(channelValue.id) : undefined;
    if (input.requireCompleteResults && rawChannelId !== undefined && !rawChannelId.trim()) {
      throw new Error("Slack search returned an invalid message channel; refusing partial output");
    }
    let channelId = rawChannelId?.trim() ?? "";
    if (!channelId && channelValue && getString(channelValue.name)) {
      try {
        channelId = await resolveChannelId(client, `#${getString(channelValue.name)}`);
      } catch (err: unknown) {
        if (input.requireCompleteResults) {
          throw new Error("Slack search returned an unresolvable message channel", { cause: err });
        }
        continue;
      }
    }
    if (!channelId) {
      if (input.requireCompleteResults) {
        throw new Error(
          "Slack search returned a message without a channel; refusing partial output",
        );
      }
      continue;
    }
    const permalink = getString(m.permalink)?.trim();
    if (input.requireCompleteResults) {
      if (!permalink) {
        throw new Error(
          "Slack search returned a message without a permalink; refusing partial output",
        );
      }
      let parsed;
      try {
        parsed = parseSlackMessageUrl(permalink);
      } catch (err: unknown) {
        throw new Error("Slack search returned an invalid message permalink", { cause: err });
      }
      if (parsed.channel_id !== channelId || parsed.message_ts !== ts) {
        throw new Error("Slack search returned a permalink for a different message");
      }
      let expectedWorkspaceOrigin: string | undefined;
      try {
        expectedWorkspaceOrigin = input.workspace_url
          ? new URL(input.workspace_url).origin
          : undefined;
      } catch {
        // Fail through the same closed contract below.
      }
      if (
        !expectedWorkspaceOrigin ||
        new URL(parsed.workspace_url).origin !== expectedWorkspaceOrigin
      ) {
        throw new Error("Slack search returned a permalink for a different workspace");
      }
    }
    messageRefs.push({
      channel_id: channelId,
      message_ts: ts,
      permalink,
    });
    if (messageRefs.length >= input.limit) {
      break;
    }
  }

  const downloadedPaths: Record<string, DownloadResult> = {};
  const downloadsDir = input.download ? await ensureDownloadsDir() : null;
  const resolvedMessages: SlackMessageSummary[] = [];
  const out: SearchCompactMessage[] = [];

  for (const ref of messageRefs) {
    let full: SlackMessageSummary | null = null;
    try {
      const parsed =
        ref.permalink && typeof ref.permalink === "string"
          ? (() => {
              try {
                return parseSlackMessageUrl(ref.permalink);
              } catch {
                return null;
              }
            })()
          : null;

      full = await fetchMessage(client, {
        ref: {
          workspace_url: parsed?.workspace_url ?? input.workspace_url ?? "",
          channel_id: ref.channel_id,
          message_ts: ref.message_ts,
          thread_ts_hint: parsed?.thread_ts_hint,
          raw: parsed?.raw ?? ref.permalink ?? `${ref.channel_id}:${ref.message_ts}`,
        },
      });
    } catch (err: unknown) {
      if (input.requireCompleteResults) {
        throw new Error(
          `Could not fetch complete Slack search result ${ref.channel_id}:${ref.message_ts}`,
          { cause: err },
        );
      }
      continue;
    }

    if (downloadsDir) {
      await downloadFilesForMessage({
        auth: input.auth,
        downloadsDir,
        message: full,
        downloadedPaths,
      });
    }

    const compact = toCompactMessage(full, {
      maxBodyChars: input.maxContentChars,
      downloadedPaths,
    });
    if (!passesContentTypeFilter(compact, input.contentType)) {
      continue;
    }
    resolvedMessages.push(full);
    out.push(toSearchCompactMessage(compact, ref.permalink));
    if (out.length >= input.limit) {
      break;
    }
  }

  const referencedUserIds = collectReferencedUserIds(resolvedMessages, {
    includeReactions: false,
  });
  const shouldResolveUsers = input.resolveUsers || input.refreshUsers;
  const usersById = shouldResolveUsers
    ? await resolveUsersById({
        client,
        workspaceUrl: input.workspace_url ?? "",
        userIds: referencedUserIds,
        forceRefresh: Boolean(input.refreshUsers),
      })
    : new Map();
  return {
    messages: out,
    referenced_users: toReferencedUsers(referencedUserIds, usersById),
  };
}

export async function searchMessagesInChannelsFallback(
  client: SlackApiClient,
  input: {
    auth: SlackAuth;
    workspace_url?: string;
    query: string;
    channels: string[];
    user?: string;
    after?: string;
    before?: string;
    limit: number;
    maxContentChars: number;
    contentType: ContentType;
    download: boolean;
    resolveUsers?: boolean;
    refreshUsers?: boolean;
  },
): Promise<SearchMessageResult> {
  const channelIds = await Promise.all(input.channels.map((c) => resolveChannelId(client, c)));
  const queryLower = input.query.trim().toLowerCase();

  const userId = input.user ? await resolveUserId(client, input.user) : undefined;

  const afterSec = input.after ? dateToUnixSeconds(input.after, "start") : null;
  const beforeSec = input.before ? dateToUnixSeconds(input.before, "end") : null;

  const downloadsDir = input.download ? await ensureDownloadsDir() : null;
  const downloadedPaths: Record<string, DownloadResult> = {};
  const matchedSummaries: SlackMessageSummary[] = [];

  const results: SearchCompactMessage[] = [];

  for (const channelId of channelIds) {
    let cursorLatest: string | undefined;
    for (;;) {
      const resp = await client.api("conversations.history", {
        channel: channelId,
        limit: 200,
        latest: cursorLatest,
      });
      const messages = isRecord(resp) ? asArray(resp.messages).filter(isRecord) : [];
      if (messages.length === 0) {
        break;
      }

      for (const m of messages) {
        const summary = messageSummaryFromApiMessage(channelId, m);

        const tsNum = Number.parseFloat(summary.ts);
        if (Number.isFinite(tsNum)) {
          if (beforeSec !== null && tsNum > beforeSec) {
            continue;
          }
          if (afterSec !== null && tsNum < afterSec) {
            cursorLatest = undefined;
            break;
          }
        }

        if (userId && summary.user !== userId) {
          continue;
        }

        const content = renderSlackMessageContent(summary);
        if (queryLower && !content.toLowerCase().includes(queryLower)) {
          continue;
        }

        if (downloadsDir) {
          await downloadFilesForMessage({
            auth: input.auth,
            downloadsDir,
            message: summary,
            downloadedPaths,
          });
        }

        const compact = toCompactMessage(summary, {
          maxBodyChars: input.maxContentChars,
          downloadedPaths,
        });
        if (!passesContentTypeFilter(compact, input.contentType)) {
          continue;
        }

        matchedSummaries.push(summary);
        results.push(toSearchCompactMessage(compact));
        if (results.length >= input.limit) {
          const referencedUserIds = collectReferencedUserIds(matchedSummaries, {
            includeReactions: false,
          });
          const usersById = await resolveUsersById({
            client,
            workspaceUrl: input.workspace_url ?? "",
            userIds: referencedUserIds,
            forceRefresh: Boolean(input.refreshUsers),
          });
          return {
            messages: results,
            referenced_users: toReferencedUsers(referencedUserIds, usersById),
          };
        }
      }

      if (!cursorLatest) {
        break;
      }

      const last = messages.at(-1);
      cursorLatest = last ? getString(last.ts) : undefined;
      if (!cursorLatest) {
        break;
      }
    }
  }

  const referencedUserIds = collectReferencedUserIds(matchedSummaries, {
    includeReactions: false,
  });
  const shouldResolveUsers = input.resolveUsers || input.refreshUsers;
  const usersById = shouldResolveUsers
    ? await resolveUsersById({
        client,
        workspaceUrl: input.workspace_url ?? "",
        userIds: referencedUserIds,
        forceRefresh: Boolean(input.refreshUsers),
      })
    : new Map();
  return {
    messages: results,
    referenced_users: toReferencedUsers(referencedUserIds, usersById),
  };
}

export function passesContentTypeFilter(m: CompactSlackMessage, contentType: ContentType): boolean {
  if (contentType === "any") {
    return true;
  }
  const hasFiles = Boolean(m.files && m.files.length > 0);
  if (contentType === "text") {
    return !hasFiles;
  }
  if (!hasFiles) {
    return false;
  }

  if (contentType === "file") {
    return true;
  }
  if (contentType === "snippet") {
    return (m.files ?? []).some((f) => f.mode === "snippet");
  }
  if (contentType === "image") {
    return (m.files ?? []).some((f) => String(f.mimetype ?? "").startsWith("image/"));
  }
  return true;
}

export type SearchCompactMessage = Omit<CompactSlackMessage, "thread_ts"> & {
  permalink?: string;
};

function toSearchCompactMessage(m: CompactSlackMessage, permalink?: string): SearchCompactMessage {
  const { thread_ts: _threadTs, ...rest } = m;
  return permalink ? { ...rest, permalink } : rest;
}

async function downloadFilesForMessage(input: {
  auth: SlackAuth;
  downloadsDir: string;
  message: SlackMessageSummary;
  downloadedPaths: Record<string, DownloadResult>;
}): Promise<void> {
  for (const f of input.message.files ?? []) {
    if (input.downloadedPaths[f.id]) {
      continue;
    }
    const url = f.url_private_download || f.url_private;
    if (!url) {
      continue;
    }
    const ext = inferExt(f);
    const result = await tryDownloadSlackFile({
      auth: input.auth,
      url,
      destDir: input.downloadsDir,
      preferredName: `${f.id}${ext ? `.${ext}` : ""}`,
    });
    if (!result.ok) {
      input.downloadedPaths[f.id] = {
        ...result,
        path: await writeDownloadErrorFile({
          destDir: input.downloadsDir,
          fileId: f.id,
          error: result.error,
        }),
      };
      console.warn(`Warning: file ${f.id}: ${result.error}`);
    } else {
      input.downloadedPaths[f.id] = result;
    }
  }
}

export function messageSummaryFromApiMessage(
  channelId: string,
  msg: Record<string, unknown>,
): SlackMessageSummary {
  const files = asArray(msg.files)
    .map((f) => toSlackFileSummary(f))
    .filter((file): file is NonNullable<typeof file> => file !== null);
  return toSlackMessageSummary({ channelId, message: msg, files });
}
