import { describe, expect, test } from "bun:test";
import type { SlackApiClient } from "../src/slack/client.ts";
import { searchMessagesViaSearchApi } from "../src/slack/search-messages.ts";
import { searchMessagesRaw } from "../src/slack/search-raw.ts";
import { searchSlack } from "../src/slack/search.ts";

const auth = { auth_type: "standard" as const, token: "test-token" };
const workspaceUrl = "https://workspace.slack.com";

function searchApiInput(rawMatches: Record<string, unknown>[]) {
  return {
    auth,
    workspace_url: workspaceUrl,
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
          { ts: "1.000001", channel: { name: "missing" } },
          { ts: "2.000002", channel: { id: "C22222222" } },
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
        searchApiInput([{ ts: "1.000001", channel: { id: "C12345678" } }]),
      ),
    ).rejects.toThrow("Could not fetch complete Slack search result C12345678:1.000001");
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
