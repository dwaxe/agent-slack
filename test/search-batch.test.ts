import { describe, expect, test } from "bun:test";
import type { CliContext } from "../src/cli/context.ts";
import {
  mergeBatchSearchMessages,
  parseBatchQueries,
  runBatchSearch,
} from "../src/cli/search-batch.ts";

describe("bounded batch search", () => {
  test("normalizes and deduplicates query input", () => {
    expect(parseBatchQueries('[" owner:me worker ", "incident", "owner:me worker"]')).toEqual([
      "owner:me worker",
      "incident",
    ]);
    expect(() => parseBatchQueries("{}")).toThrow("JSON array");
    expect(() => parseBatchQueries("[]")).toThrow("1-20 queries");
    expect(() =>
      parseBatchQueries(JSON.stringify(Array.from({ length: 21 }, (_, i) => `q${i}`))),
    ).toThrow("1-20 queries");
  });

  test("deduplicates overlapping refs and records matching query indexes", () => {
    const messages = mergeBatchSearchMessages({
      queries: ["worker", "incident"],
      maxResults: 2,
      results: [
        {
          metadata_only: true,
          messages: [
            {
              channel_id: "C12345678",
              ts: "1700000000.000001",
              permalink: "https://workspace.slack.com/archives/C12345678/p1700000000000001",
            },
          ],
        },
        {
          metadata_only: true,
          messages: [
            {
              channel_id: "C12345678",
              ts: "1700000000.000001",
              permalink: "https://workspace.slack.com/archives/C12345678/p1700000000000001",
            },
            {
              channel_id: "C87654321",
              ts: "1700000001.000002",
              permalink: "https://workspace.slack.com/archives/C87654321/p1700000001000002",
            },
          ],
        },
      ],
    });

    expect(messages).toEqual([
      {
        channel_id: "C12345678",
        ts: "1700000000.000001",
        permalink: "https://workspace.slack.com/archives/C12345678/p1700000000000001",
        matched_queries: [0, 1],
      },
      {
        channel_id: "C87654321",
        ts: "1700000001.000002",
        permalink: "https://workspace.slack.com/archives/C87654321/p1700000001000002",
        matched_queries: [1],
      },
    ]);
  });

  test("runs all queries through one resolved workspace without hydrating results", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = {
      effectiveWorkspaceUrl: () => "https://workspace.slack.com",
      withAutoRefresh: async (input: { work: () => Promise<unknown> }) => await input.work(),
      getClientForWorkspace: async () => ({
        workspace_url: "https://workspace.slack.com",
        auth: { auth_type: "standard", token: "test-token" },
        client: {
          api: async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params });
            const query = String(params.query);
            return {
              messages: {
                matches: [
                  {
                    channel: { id: "C12345678" },
                    ts: "1700000000.000001",
                    permalink: "https://workspace.slack.com/archives/C12345678/p1700000000000001",
                    text: `untrusted ${query}`,
                  },
                ],
                paging: { count: 20, page: 1, pages: 1, total: 1 },
                total: 1,
              },
            };
          },
        },
      }),
    } as unknown as CliContext;

    const payload = await runBatchSearch({
      ctx,
      queries: ["worker", "incident"],
      options: { limit: "20", maxResults: "5" },
    });

    expect(calls.map((call) => call.method)).toEqual(["search.messages", "search.messages"]);
    expect(calls.map((call) => call.params.query)).toEqual(["worker", "incident"]);
    expect(payload.messages).toEqual([
      {
        channel_id: "C12345678",
        ts: "1700000000.000001",
        permalink: "https://workspace.slack.com/archives/C12345678/p1700000000000001",
        matched_queries: [0, 1],
      },
    ]);
  });

  test("fails closed when the deduplicated bound is exceeded", () => {
    expect(() =>
      mergeBatchSearchMessages({
        queries: ["worker"],
        maxResults: 1,
        results: [
          {
            metadata_only: true,
            messages: [
              {
                channel_id: "C12345678",
                ts: "1700000000.000001",
                permalink: "https://workspace.slack.com/archives/C12345678/p1700000000000001",
              },
              {
                channel_id: "C12345678",
                ts: "1700000001.000002",
                permalink: "https://workspace.slack.com/archives/C12345678/p1700000001000002",
              },
            ],
          },
        ],
      }),
    ).toThrow("exceeding --max-results 1");
  });

  test("rejects malformed bounds and mismatched result sets", async () => {
    expect(() =>
      mergeBatchSearchMessages({ queries: ["worker"], results: [], maxResults: 1 }),
    ).toThrow("result count does not match");

    const ctx = {
      effectiveWorkspaceUrl: () => "https://workspace.slack.com",
    } as unknown as CliContext;
    await expect(
      runBatchSearch({
        ctx,
        queries: ["worker"],
        options: { limit: "20oops", maxResults: "5" },
      }),
    ).rejects.toThrow("--limit must be an integer");
  });
});
