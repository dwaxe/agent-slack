import type { SlackApiClient } from "./client.ts";
import { getString, isRecord } from "../lib/object-type-guards.ts";
import { canonicalSlackTextContentSha256, slackTextContentSha256 } from "./content-identity.ts";
import { slackMrkdwnToMarkdown } from "./mrkdwn.ts";
import { isUserId } from "./user-id.ts";

const SLACK_TIMESTAMP_PATTERN = /^(0|[1-9]\d{0,12})\.(\d{6})$/;
const MICROS_PER_SECOND = 1_000_000n;

export const OWN_MESSAGE_EXPORT_PAGE_SIZE = 100;
export const OWN_MESSAGE_EXPORT_MAX_PAGES = 100;

type ParsedSlackTimestamp = {
  value: string;
  seconds: bigint;
  micros: bigint;
};

type OwnMessageCandidate = {
  channelId: string;
  channel: Record<string, unknown> | null;
  ts: ParsedSlackTimestamp;
  content: string;
  contentSha256: string;
  canonicalContentSha256: string;
  permalink?: string;
};

export type OwnMessageExportMessage = {
  channel_id: string;
  ts: string;
  content: string;
  content_sha256: string;
  canonical_content_sha256: string;
  permalink?: string;
};

export type OwnMessageExport = {
  schema_version: 1;
  complete: boolean;
  workspace_url: string;
  team_id: string;
  user_id: string;
  oldest: string;
  latest: string | null;
  messages: OwnMessageExportMessage[];
};

export function parseExactSlackTimestamp(value: string, optionName: string): ParsedSlackTimestamp {
  const trimmed = value.trim();
  const match = SLACK_TIMESTAMP_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid ${optionName}: expected an exact Slack timestamp like 1700000000.000001`,
    );
  }

  const seconds = BigInt(match[1]!);
  dateFromTimestampSeconds(seconds);
  const micros = seconds * MICROS_PER_SECOND + BigInt(match[2]!);
  return { value: trimmed, seconds, micros };
}

export function buildOwnMessageSearchQuery(input: {
  userId: string;
  oldest: ParsedSlackTimestamp;
  latest?: ParsedSlackTimestamp;
}): string {
  const parts = [`from:<@${input.userId}>`, `after:${utcDateOffset(input.oldest.seconds, -1)}`];
  if (input.latest) {
    parts.push(`before:${utcDateOffset(input.latest.seconds, 1)}`);
  }
  return parts.join(" ");
}

/**
 * Export the authenticated user's channel messages without fetching message
 * histories, resolving users, or downloading/enriching attachments.
 */
export async function exportOwnMessages(input: {
  client: SlackApiClient;
  workspaceUrl?: string;
  oldest: string;
  latest?: string;
  pageCap?: number;
}): Promise<OwnMessageExport> {
  const oldest = parseExactSlackTimestamp(input.oldest, "--oldest");
  const latest = input.latest ? parseExactSlackTimestamp(input.latest, "--latest") : undefined;
  if (latest && latest.micros < oldest.micros) {
    throw new Error("Invalid window: --latest must be greater than or equal to --oldest");
  }

  const authTest = await input.client.api("auth.test", {});
  const teamId = getString(authTest.team_id)?.trim();
  const userId = getString(authTest.user_id)?.trim();
  const authenticatedWorkspaceUrl = getString(authTest.url)?.trim();
  if (!teamId) {
    throw new Error("Slack auth.test did not return team_id");
  }
  if (!userId || !isUserId(userId)) {
    throw new Error("Slack auth.test did not return a valid user_id");
  }
  if (!authenticatedWorkspaceUrl) {
    throw new Error("Slack auth.test did not return a workspace URL");
  }
  const authenticatedWorkspace = normalizeSlackWorkspaceOrigin(authenticatedWorkspaceUrl);
  const expectedWorkspace = resolveExportWorkspaceClaim(input.workspaceUrl, authenticatedWorkspace);

  const pageCap = normalizePageCap(input.pageCap);
  const query = buildOwnMessageSearchQuery({ userId, oldest, latest });
  const searched = await searchOwnMessageCandidates({
    client: input.client,
    query,
    userId,
    oldest,
    latest,
    pageCap,
  });

  const channelAccess = new Map<string, boolean>();
  for (const candidate of searched.candidates) {
    if (channelAccess.has(candidate.channelId)) {
      continue;
    }
    channelAccess.set(
      candidate.channelId,
      await isNonDmChannel({
        client: input.client,
        channelId: candidate.channelId,
        searchChannel: candidate.channel,
      }),
    );
  }

  const deduped = new Map<string, OwnMessageExportMessage>();
  for (const candidate of searched.candidates) {
    if (!channelAccess.get(candidate.channelId)) {
      continue;
    }
    const message: OwnMessageExportMessage = {
      channel_id: candidate.channelId,
      ts: candidate.ts.value,
      content: candidate.content,
      content_sha256: candidate.contentSha256,
      canonical_content_sha256: candidate.canonicalContentSha256,
      ...(candidate.permalink ? { permalink: candidate.permalink } : {}),
    };
    const key = `${message.channel_id}\u0000${message.ts}`;
    const existing = deduped.get(key);
    if (!existing || shouldReplaceDuplicate(existing, message)) {
      deduped.set(key, message);
    }
  }

  const messages = [...deduped.values()].sort((a, b) => {
    const aTs = parseExactSlackTimestamp(a.ts, "message ts").micros;
    const bTs = parseExactSlackTimestamp(b.ts, "message ts").micros;
    if (aTs === bTs) {
      return a.channel_id.localeCompare(b.channel_id);
    }
    return aTs < bTs ? -1 : 1;
  });

  return {
    schema_version: 1,
    complete: searched.complete,
    workspace_url: expectedWorkspace,
    team_id: teamId,
    user_id: userId,
    oldest: oldest.value,
    latest: latest?.value ?? null,
    messages,
  };
}

function resolveExportWorkspaceClaim(
  claim: string | undefined,
  authenticatedWorkspace: string,
): string {
  const value = claim?.trim();
  if (!value) {
    return authenticatedWorkspace;
  }
  try {
    if (normalizeSlackWorkspaceOrigin(value) !== authenticatedWorkspace) {
      throw new Error("Slack authentication resolved to a different workspace than requested");
    }
    return authenticatedWorkspace;
  } catch (error) {
    if (error instanceof Error && error.message.includes("different workspace")) {
      throw error;
    }
    const selector = value.toLowerCase();
    const host = new URL(authenticatedWorkspace).hostname.toLowerCase();
    const shortHost = host.replace(/\.(?:slack\.com|slack-gov\.com)$/i, "");
    if (
      !authenticatedWorkspace.toLowerCase().includes(selector) &&
      !host.includes(selector) &&
      !shortHost.includes(selector)
    ) {
      throw new Error("Slack authentication resolved to a different workspace than requested");
    }
    return authenticatedWorkspace;
  }
}

function normalizeSlackWorkspaceOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Slack auth.test returned an invalid workspace URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^.+\.(?:slack\.com|slack-gov\.com)$/i.test(url.hostname)
  ) {
    throw new Error("Slack auth.test returned an invalid workspace URL");
  }
  return `https://${url.hostname.toLowerCase()}`;
}

async function searchOwnMessageCandidates(input: {
  client: SlackApiClient;
  query: string;
  userId: string;
  oldest: ParsedSlackTimestamp;
  latest?: ParsedSlackTimestamp;
  pageCap: number;
}): Promise<{ complete: boolean; candidates: OwnMessageCandidate[] }> {
  const candidates: OwnMessageCandidate[] = [];

  for (let page = 1; page <= input.pageCap; page++) {
    const response = await input.client.api("search.messages", {
      query: input.query,
      count: OWN_MESSAGE_EXPORT_PAGE_SIZE,
      page,
      highlight: false,
      sort: "timestamp",
      sort_dir: "asc",
    });
    const responseMessages = isRecord(response.messages) ? response.messages : null;
    if (!responseMessages || !Array.isArray(responseMessages.matches)) {
      throw new Error("Slack search.messages returned an invalid messages payload");
    }
    const matches = responseMessages.matches.filter(isRecord);
    for (const match of matches) {
      const candidate = candidateFromSearchMatch(match, {
        userId: input.userId,
        oldest: input.oldest,
        latest: input.latest,
      });
      if (candidate) {
        candidates.push(candidate);
      }
    }

    const totalPages = searchTotalPages(responseMessages);
    const hasAnotherPage =
      totalPages !== null ? page < totalPages : matches.length === OWN_MESSAGE_EXPORT_PAGE_SIZE;
    if (!hasAnotherPage || matches.length === 0) {
      return { complete: true, candidates };
    }
  }

  return { complete: false, candidates };
}

function candidateFromSearchMatch(
  match: Record<string, unknown>,
  input: {
    userId: string;
    oldest: ParsedSlackTimestamp;
    latest?: ParsedSlackTimestamp;
  },
): OwnMessageCandidate | null {
  const authorId = getString(match.user_id) ?? getString(match.user);
  if (authorId !== input.userId) {
    return null;
  }

  const rawTs = getString(match.ts);
  if (!rawTs) {
    return null;
  }
  let ts: ParsedSlackTimestamp;
  try {
    ts = parseExactSlackTimestamp(rawTs, "message ts");
  } catch {
    return null;
  }
  if (ts.micros < input.oldest.micros || (input.latest && ts.micros > input.latest.micros)) {
    return null;
  }

  const channel = isRecord(match.channel) ? match.channel : null;
  const channelId = (getString(channel?.id) ?? getString(match.channel_id))?.trim();
  if (!channelId) {
    return null;
  }

  const permalink = getString(match.permalink)?.trim();
  const rawContent = getString(match.text) ?? "";
  return {
    channelId,
    channel,
    ts,
    // Only the top-level text is the authenticated user's own writing. Blocks
    // and attachments can contain quoted, forwarded, or generated content.
    content: slackMrkdwnToMarkdown(rawContent).trim(),
    // Receipts hash the exact outbound Slack text, so retain a hash of the raw
    // top-level value before Markdown conversion or whitespace normalization.
    contentSha256: slackTextContentSha256(rawContent),
    canonicalContentSha256: canonicalSlackTextContentSha256(rawContent),
    ...(permalink ? { permalink } : {}),
  };
}

async function isNonDmChannel(input: {
  client: SlackApiClient;
  channelId: string;
  searchChannel: Record<string, unknown> | null;
}): Promise<boolean> {
  if (input.searchChannel?.is_im === true || input.searchChannel?.is_mpim === true) {
    return false;
  }
  if (input.channelId.startsWith("D")) {
    return false;
  }
  if (input.channelId.startsWith("C")) {
    return true;
  }

  const response = await input.client.api("conversations.info", { channel: input.channelId });
  const channel = isRecord(response.channel) ? response.channel : null;
  if (!channel) {
    throw new Error(`Slack conversations.info returned no channel for ${input.channelId}`);
  }
  if (channel.is_im === true || channel.is_mpim === true) {
    return false;
  }
  if (channel.is_channel === true || channel.is_group === true) {
    return true;
  }
  throw new Error(`Could not verify that ${input.channelId} is a public or private channel`);
}

function searchTotalPages(messages: Record<string, unknown>): number | null {
  const paging = isRecord(messages.paging)
    ? messages.paging
    : isRecord(messages.pagination)
      ? messages.pagination
      : null;
  if (!paging) {
    return null;
  }
  const value = paging.pages ?? paging.page_count;
  const pages = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(pages) && pages > 0 ? pages : null;
}

function normalizePageCap(value: number | undefined): number {
  if (value === undefined) {
    return OWN_MESSAGE_EXPORT_MAX_PAGES;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > OWN_MESSAGE_EXPORT_MAX_PAGES) {
    throw new Error(
      `Invalid export page cap: expected an integer from 1 to ${OWN_MESSAGE_EXPORT_MAX_PAGES}`,
    );
  }
  return value;
}

function utcDateOffset(seconds: bigint, days: number): string {
  const date = dateFromTimestampSeconds(seconds);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateFromTimestampSeconds(seconds: bigint): Date {
  const secondsNumber = Number(seconds);
  if (!Number.isSafeInteger(secondsNumber)) {
    throw new Error("Slack timestamp seconds are outside the supported range");
  }
  const date = new Date(secondsNumber * 1000);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Slack timestamp is outside the supported date range");
  }
  return date;
}

function shouldReplaceDuplicate(
  existing: OwnMessageExportMessage,
  candidate: OwnMessageExportMessage,
): boolean {
  if (Boolean(existing.content) !== Boolean(candidate.content)) {
    return Boolean(candidate.content);
  }
  return !existing.permalink && Boolean(candidate.permalink);
}
