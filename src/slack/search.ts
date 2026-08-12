import type { SlackApiClient, SlackAuth } from "./client.ts";
import type { CompactSlackUser } from "./users.ts";
import { buildSlackSearchQuery } from "./search-query.ts";
import { searchFilesRaw, searchMessagesRaw } from "./search-raw.ts";
import { searchFilesInChannelsFallback, searchFilesViaSearchApi } from "./search-files.ts";
import {
  type SearchCompactMessage,
  searchMessagesInChannelsFallback,
  searchMessagesViaSearchApi,
} from "./search-messages.ts";

export type SearchKind = "messages" | "files" | "all";
export type ContentType = "any" | "text" | "image" | "snippet" | "file";

export type SearchOptions = {
  workspace_url?: string;
  query: string;
  kind: SearchKind;
  channels?: string[];
  user?: string; // @name, name, or U.../W...
  after?: string; // YYYY-MM-DD
  before?: string; // YYYY-MM-DD
  content_type?: ContentType;
  limit?: number;
  max_content_chars?: number;
  download?: boolean;
  resolve_users?: boolean;
  refresh_users?: boolean;
  require_complete_results?: boolean;
  metadata_only?: boolean;
};

export type SearchResult = {
  messages?: SearchCompactMessage[];
  files?: { title?: string; mimetype?: string; mode?: string; path: string }[];
  referenced_users?: Record<string, CompactSlackUser>;
  metadata_only?: true;
};

export async function searchSlack(input: {
  client: SlackApiClient;
  auth: SlackAuth;
  options: SearchOptions;
}): Promise<SearchResult> {
  const limit = Math.min(Math.max(input.options.limit ?? 20, 1), 200);
  const maxContentChars = input.options.max_content_chars ?? 4000;
  const contentType = input.options.content_type ?? "any";
  const metadataOnly = Boolean(input.options.metadata_only);
  const download = metadataOnly ? false : (input.options.download ?? true);
  const requireCompleteResults = Boolean(input.options.require_complete_results || metadataOnly);
  if (metadataOnly && input.options.kind !== "messages") {
    throw new Error("--metadata-only is supported only by search messages");
  }
  if (metadataOnly && input.options.channels?.length) {
    throw new Error("--metadata-only is not supported with --channel fallback search");
  }
  if (metadataOnly && contentType !== "any") {
    throw new Error("--metadata-only cannot be combined with --content-type");
  }
  if (metadataOnly && (input.options.resolve_users || input.options.refresh_users)) {
    throw new Error("--metadata-only cannot be combined with user resolution options");
  }
  if (!download && (input.options.kind === "files" || input.options.kind === "all")) {
    throw new Error("File search requires downloads enabled (so agents get local file paths).");
  }
  if (requireCompleteResults && input.options.channels?.length) {
    throw new Error("--require-complete-results is not supported with --channel fallback search");
  }

  const slackQuery = await buildSlackSearchQuery(input.client, {
    query: input.options.query,
    channels: input.options.channels,
    user: input.options.user,
    after: input.options.after,
    before: input.options.before,
  });

  const out: SearchResult = { metadata_only: metadataOnly ? true : undefined };

  if (input.options.kind === "messages" || input.options.kind === "all") {
    if (input.options.channels?.length) {
      const messageResult = await searchMessagesInChannelsFallback(input.client, {
        auth: input.auth,
        workspace_url: input.options.workspace_url,
        query: input.options.query,
        channels: input.options.channels,
        user: input.options.user,
        after: input.options.after,
        before: input.options.before,
        limit,
        maxContentChars,
        contentType,
        download,
        resolveUsers: input.options.resolve_users,
        refreshUsers: input.options.refresh_users,
      });
      out.messages = messageResult.messages;
      if (!metadataOnly) {
        out.referenced_users = messageResult.referenced_users;
      }
    } else {
      const rawMatches = await searchMessagesRaw(input.client, {
        query: slackQuery,
        limit,
        requireCompleteResults,
      });
      const messageResult = await searchMessagesViaSearchApi(input.client, {
        auth: input.auth,
        workspace_url: input.options.workspace_url,
        slack_query: slackQuery,
        limit,
        maxContentChars,
        contentType,
        download,
        rawMatches,
        resolveUsers: input.options.resolve_users,
        refreshUsers: input.options.refresh_users,
        requireCompleteResults,
        metadataOnly,
      });
      out.messages = messageResult.messages;
      out.referenced_users = messageResult.referenced_users;
    }
  }

  if (input.options.kind === "files" || input.options.kind === "all") {
    if (input.options.channels?.length) {
      out.files = await searchFilesInChannelsFallback(input.client, {
        auth: input.auth,
        query: input.options.query,
        channels: input.options.channels,
        user: input.options.user,
        after: input.options.after,
        before: input.options.before,
        limit,
        contentType,
      });
    } else {
      const rawMatches = await searchFilesRaw(input.client, { query: slackQuery, limit });
      out.files = await searchFilesViaSearchApi(input.client, {
        auth: input.auth,
        slack_query: slackQuery,
        limit,
        contentType,
        rawMatches,
      });
    }
  }

  return out;
}
