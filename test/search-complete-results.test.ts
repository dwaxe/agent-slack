import { describe, expect, test } from "bun:test";
import type { SlackApiClient } from "../src/slack/client.ts";
import { searchMessagesViaSearchApi } from "../src/slack/search-messages.ts";
import { searchMessagesRaw } from "../src/slack/search-raw.ts";
import { searchSlack } from "../src/slack/search.ts";

const auth = { auth_type: "standard" as const, token: "test-token" };
const workspaceUrl = "https://workspace.slack.com";

function rawMatches(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    ts: `${index + 1}.000001`,
    channel: { id: "C12345678" },
    permalink: `${workspaceUrl}/archives/C12345678/p${index + 1}000001`,
  }));
}

function searchApiInput(rawMatches: Record<string, unknown>[], workspace_url = workspaceUrl) {
  return {
    auth,
    workspace_url,
    slack_query: "alias",
    limit: 20,
    maxContentChars: 4000,
    contentType: "any" as const,
    download: false,
    rawMatches,
    requireCompleteResults: true,
  };
}

describe("complete Slack message search results", () => {
  test("rejects a malformed raw search match", async () => {
    const client = {
      api: async () => ({ messages: { matches: [null, { ts: "1.000001" }] } }),
    } as unknown as SlackApiClient;

    await expect(
      searchMessagesRaw(client, {
        query: "alias",
        limit: 20,
        requireCompleteResults: true,
      }),
    ).rejects.toThrow("malformed message result");
  });

  test("rejects a malformed search response instead of treating it as empty", async () => {
    const client = {
      api: async () => ({ messages: { paging: { pages: 1 } } }),
    } as unknown as SlackApiClient;

    await expect(
      searchMessagesRaw(client, {
        query: "alias",
        limit: 20,
        requireCompleteResults: true,
      }),
    ).rejects.toThrow("omitted its message matches");
  });

  test("rejects omitted and malformed paging metadata", async () => {
    for (const paging of [
      undefined,
      { count: 20, page: "1", pages: 1, total: 1 },
      { count: 19, page: 1, pages: 1, total: 1 },
    ]) {
      const client = {
        api: async () => ({ messages: { matches: rawMatches(1), paging } }),
      } as unknown as SlackApiClient;

      await expect(
        searchMessagesRaw(client, {
          query: "alias",
          limit: 20,
          requireCompleteResults: true,
        }),
      ).rejects.toThrow(/paging metadata/);
    }
  });

  test("rejects a declared total that a short page does not satisfy", async () => {
    const client = {
      api: async () => ({
        messages: {
          matches: rawMatches(50),
          paging: { count: 51, page: 1, pages: 1, total: 51 },
        },
      }),
    } as unknown as SlackApiClient;

    await expect(
      searchMessagesRaw(client, {
        query: "alias",
        limit: 51,
        requireCompleteResults: true,
      }),
    ).rejects.toThrow("short message page before the declared total");
  });

  test("rejects an unexpected page and an early empty page", async () => {
    const responses = [
      { matches: rawMatches(1), paging: { count: 1, page: 2, pages: 1, total: 1 } },
      { matches: [], paging: { count: 1, page: 1, pages: 1, total: 1 } },
    ];

    for (const messages of responses) {
      const client = {
        api: async () => ({ messages }),
      } as unknown as SlackApiClient;
      await expect(
        searchMessagesRaw(client, {
          query: "alias",
          limit: 1,
          requireCompleteResults: true,
        }),
      ).rejects.toThrow(/requested|empty message page/);
    }
  });

  test("accepts a proven total below the requested boundary", async () => {
    const client = {
      api: async () => ({
        messages: {
          matches: rawMatches(50),
          paging: { count: 51, page: 1, pages: 1, total: 50 },
        },
      }),
    } as unknown as SlackApiClient;

    const matches = await searchMessagesRaw(client, {
      query: "alias",
      limit: 51,
      requireCompleteResults: true,
    });

    expect(matches).toHaveLength(50);
  });

  test("rejects an unresolvable match instead of returning later partial results", async () => {
    const client = {
      api: async (method: string) => {
        if (method === "conversations.info") {
          throw new Error("channel_not_found");
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as SlackApiClient;

    await expect(
      searchMessagesViaSearchApi(
        client,
        searchApiInput([
          {
            ts: "1.000001",
            channel: { name: "missing" },
            permalink: `${workspaceUrl}/archives/C11111111/p1000001`,
          },
          {
            ts: "2.000002",
            channel: { id: "C22222222" },
            permalink: `${workspaceUrl}/archives/C22222222/p2000002`,
          },
        ]),
      ),
    ).rejects.toThrow("unresolvable message channel");
  });

  test("rejects when a resolved search match cannot be fetched", async () => {
    const client = {
      api: async () => ({ messages: [] }),
    } as unknown as SlackApiClient;

    await expect(
      searchMessagesViaSearchApi(
        client,
        searchApiInput([
          {
            ts: "1.000001",
            channel: { id: "C12345678" },
            permalink: `${workspaceUrl}/archives/C12345678/p1000001`,
          },
        ]),
      ),
    ).rejects.toThrow("Could not fetch complete Slack search result C12345678:1.000001");
  });

  test("accepts a canonical permalink when the workspace selector has a trailing slash", async () => {
    const client = {
      api: async () => ({
        messages: [{ ts: "1.000001", text: "result" }],
      }),
    } as unknown as SlackApiClient;

    const result = await searchMessagesViaSearchApi(
      client,
      searchApiInput(
        [
          {
            ts: "1.000001",
            channel: { id: "C12345678" },
            permalink: `${workspaceUrl}/archives/C12345678/p1000001`,
          },
        ],
        `${workspaceUrl}/`,
      ),
    );

    expect(result.messages).toHaveLength(1);
  });

  test("rejects missing, malformed, and mismatched permalinks", async () => {
    const client = {
      api: async () => {
        throw new Error("No API call expected before permalink validation");
      },
    } as unknown as SlackApiClient;
    const matches = [
      { ts: "1.000001", channel: { id: "C12345678" } },
      {
        ts: "1.000001",
        channel: { id: "C12345678" },
        permalink: "not-a-url",
      },
      {
        ts: "1.000001",
        channel: { id: "C12345678" },
        permalink: `${workspaceUrl}/archives/C99999999/p1000001`,
      },
      {
        ts: "1.000001",
        channel: { id: "C12345678" },
        permalink: `${workspaceUrl}/archives/C12345678/p2000002`,
      },
      {
        ts: "1.000001",
        channel: { id: "C12345678" },
        permalink: "https://different.slack.com/archives/C12345678/p1000001",
      },
    ];

    for (const match of matches) {
      await expect(searchMessagesViaSearchApi(client, searchApiInput([match]))).rejects.toThrow(
        /permalink/,
      );
    }
  });

  test("rejects channel fallback mode before searching", async () => {
    const methods: string[] = [];
    const client = {
      api: async (method: string) => {
        methods.push(method);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as SlackApiClient;

    await expect(
      searchSlack({
        client,
        auth,
        options: {
          query: "alias",
          kind: "messages",
          channels: ["C12345678"],
          require_complete_results: true,
          download: false,
        },
      }),
    ).rejects.toThrow("not supported with --channel fallback search");
    expect(methods).toHaveLength(0);
  });
});
