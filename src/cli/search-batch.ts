import { readFileSync } from "node:fs";
import type { CliContext } from "./context.ts";
import { searchSlack } from "../slack/search.ts";
import { isRecord } from "../lib/object-type-guards.ts";

const MAX_BATCH_QUERIES = 20;
const MAX_QUERY_CHARS = 1_000;

export type SearchBatchOptions = {
  workspace?: string;
  user?: string;
  after?: string;
  before?: string;
  limit?: string;
  maxResults?: string;
};

type BatchMessage = {
  channel_id: string;
  ts: string;
  permalink: string;
  matched_queries: number[];
};

export function parseBatchQueries(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(
      `Search batch input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Search batch input must be a JSON array of query strings");
  }
  if (parsed.length === 0 || parsed.length > MAX_BATCH_QUERIES) {
    throw new Error(`Search batch input must contain 1-${MAX_BATCH_QUERIES} queries`);
  }

  const queries: string[] = [];
  const seen = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== "string") {
      throw new Error("Every search batch query must be a string");
    }
    const query = value.trim();
    if (!query) {
      throw new Error("Search batch queries must not be empty");
    }
    if (query.length > MAX_QUERY_CHARS) {
      throw new Error(`Search batch queries must be at most ${MAX_QUERY_CHARS} characters`);
    }
    if (!seen.has(query)) {
      seen.add(query);
      queries.push(query);
    }
  }
  return queries;
}

export function readBatchQueries(path: string): string[] {
  const raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  return parseBatchQueries(raw);
}

function parseBoundedInteger(input: {
  raw: string | undefined;
  option: string;
  fallback: number;
  max: number;
}): number {
  const raw = input.raw ?? String(input.fallback);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${input.option} must be an integer from 1 to ${input.max}`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > input.max) {
    throw new Error(`${input.option} must be an integer from 1 to ${input.max}`);
  }
  return value;
}

export function mergeBatchSearchMessages(input: {
  queries: string[];
  results: Record<string, unknown>[];
  maxResults: number;
}): BatchMessage[] {
  if (input.results.length !== input.queries.length) {
    throw new Error("Search batch result count does not match its query count");
  }
  const messages = new Map<string, BatchMessage>();
  for (const [queryIndex, result] of input.results.entries()) {
    if (result.metadata_only !== true || !Array.isArray(result.messages)) {
      throw new Error(`Search batch query ${queryIndex} did not return metadata-only results`);
    }
    for (const candidate of result.messages) {
      if (!isRecord(candidate)) {
        throw new Error(`Search batch query ${queryIndex} returned a malformed message`);
      }
      const { channel_id: channelId, ts, permalink } = candidate;
      if (
        typeof channelId !== "string" ||
        typeof ts !== "string" ||
        typeof permalink !== "string"
      ) {
        throw new Error(
          `Search batch query ${queryIndex} returned an incomplete message reference`,
        );
      }
      const key = `${channelId}\u0000${ts}`;
      const existing = messages.get(key);
      if (existing) {
        if (existing.permalink !== permalink) {
          throw new Error("Search batch returned conflicting permalinks for one message");
        }
        if (!existing.matched_queries.includes(queryIndex)) {
          existing.matched_queries.push(queryIndex);
        }
        continue;
      }
      messages.set(key, {
        channel_id: channelId,
        ts,
        permalink,
        matched_queries: [queryIndex],
      });
    }
  }
  if (messages.size > input.maxResults) {
    throw new Error(
      `Search batch produced ${messages.size} unique messages, exceeding --max-results ${input.maxResults}; narrow the queries or raise the bound`,
    );
  }
  return [...messages.values()];
}

export async function runBatchSearch(input: {
  ctx: CliContext;
  queries: string[];
  options: SearchBatchOptions;
}): Promise<Record<string, unknown>> {
  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  const limit = parseBoundedInteger({
    raw: input.options.limit,
    option: "--limit",
    fallback: 20,
    max: 200,
  });
  const maxResults = parseBoundedInteger({
    raw: input.options.maxResults,
    option: "--max-results",
    fallback: 200,
    max: 1_000,
  });

  return await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client, auth, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const resolvedWorkspace = workspace_url ?? workspaceUrl ?? "";
      const results: Record<string, unknown>[] = [];
      for (const query of input.queries) {
        results.push(
          await searchSlack({
            client,
            auth,
            options: {
              workspace_url: resolvedWorkspace,
              query,
              kind: "messages",
              user: input.options.user,
              after: input.options.after,
              before: input.options.before,
              limit,
              download: false,
              require_complete_results: true,
              metadata_only: true,
            },
          }),
        );
      }
      const messages = mergeBatchSearchMessages({
        queries: input.queries,
        results,
        maxResults,
      });
      return {
        schema_version: 1,
        metadata_only: true,
        workspace_url: resolvedWorkspace,
        queries: input.queries,
        query_limit: limit,
        messages,
      };
    },
  });
}
