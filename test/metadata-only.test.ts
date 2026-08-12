import { describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { handleMessageList } from "../src/cli/message-read-actions.ts";
import { registerSearchCommand } from "../src/cli/search-command.ts";
import type { SlackApiClient } from "../src/slack/client.ts";
import { searchSlack } from "../src/slack/search.ts";

type ApiCall = { method: string; params: Record<string, unknown> };

describe("metadata-only reads", () => {
  test("message list scans mention surfaces but omits content, file enrichment, and downloads", async () => {
    const threadTs = "1700000000.000001";
    const calls: ApiCall[] = [];
    const root = {
      ts: threadTs,
      text: "poison content <@U11111111>",
      user: "U99999999",
      bot_id: "B99999999",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "usergroup", usergroup_id: "S11111111" }],
            },
          ],
        },
      ],
      files: [
        {
          id: "F11111111",
          mode: "snippet",
          url_private_download: "https://files.slack.com/files-pri/F11111111/download",
        },
      ],
    };
    const reply = {
      ts: "1700000001.000002",
      thread_ts: threadTs,
      text: "reply poison",
      bot_id: "B88888888",
      files: [
        {
          id: "F22222222",
          mode: "snippet",
          url_private_download: "https://files.slack.com/files-pri/F22222222/download",
        },
      ],
    };
    const client = {
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "conversations.history") {
          return { messages: [root] };
        }
        if (method === "conversations.replies") {
          return {
            messages: [reply, root],
            has_more: false,
            response_metadata: { next_cursor: "" },
          };
        }
        throw new Error(`Unexpected Slack method: ${method}`);
      },
    };
    const ctx = {
      effectiveWorkspaceUrl: () => undefined,
      withAutoRefresh: async (input: { work: () => Promise<unknown> }) => await input.work(),
      getClientForWorkspace: async () => ({
        client,
        auth: { auth_type: "standard", token: "test-token" },
        workspace_url: "https://workspace.slack.com",
      }),
    } as unknown as CliContext;
    const originalFetch = globalThis.fetch;
    const download = mock(() => {
      throw new Error("Unexpected file download");
    });
    globalThis.fetch = download as unknown as typeof fetch;

    try {
      const payload = await handleMessageList({
        ctx,
        targetInput: "https://workspace.slack.com/archives/C12345678/p1700000000000001",
        options: { maxBodyChars: "8000", metadataOnly: true },
      });

      expect(payload).toEqual({
        metadata_only: true,
        thread_complete: true,
        messages: [
          {
            ts: threadTs,
            author: { user_id: "U99999999", bot_id: "B99999999" },
            mention_evidence: {
              schema: 2,
              complete: true,
              user_ids: ["U11111111"],
              usergroup_ids: ["S11111111"],
            },
          },
          {
            ts: reply.ts,
            author: { bot_id: "B88888888" },
            mention_evidence: {
              schema: 2,
              complete: true,
              user_ids: [],
              usergroup_ids: [],
            },
          },
        ],
      });
      expect(calls.map((call) => call.method)).toEqual(["conversations.replies"]);
      expect(download).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("channel history rejects noncanonical metadata-only identities", async () => {
    const canonicalTs = "1700000000.000001";
    const malformedMessages = [
      { ts: "1700000000.1", user: "U11111111" },
      { ts: canonicalTs, user: "not-a-user" },
      { ts: canonicalTs, bot_id: "not-a-bot" },
      { ts: canonicalTs },
    ];

    for (const message of malformedMessages) {
      const client = {
        api: async (method: string) => {
          if (method === "conversations.history") {
            return { messages: [message] };
          }
          throw new Error(`Unexpected Slack method: ${method}`);
        },
      };
      const ctx = {
        effectiveWorkspaceUrl: () => "https://workspace.slack.com",
        assertWorkspaceSpecifiedForChannelNames: async () => {},
        withAutoRefresh: async (input: { work: () => Promise<unknown> }) => await input.work(),
        getClientForWorkspace: async () => ({
          client,
          auth: { auth_type: "standard", token: "test-token" },
          workspace_url: "https://workspace.slack.com",
        }),
      } as unknown as CliContext;

      await expect(
        handleMessageList({
          ctx,
          targetInput: "C12345678",
          options: { maxBodyChars: "8000", metadataOnly: true },
        }),
      ).rejects.toThrow(/validated (canonical timestamp|author identity)/);
    }
  });

  test("search returns only strictly validated refs without hydrating or downloading messages", async () => {
    const calls: ApiCall[] = [];
    const permalink = "https://workspace.slack.com/archives/C12345678/p1700000000000001";
    const client = {
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "search.messages") {
          return {
            messages: {
              matches: [
                {
                  ts: "1700000000.000001",
                  channel: { id: "C12345678" },
                  permalink,
                  text: "poison content",
                  files: [{ id: "F11111111", mode: "snippet" }],
                },
              ],
              paging: { count: 20, page: 1, pages: 1, total: 1 },
              total: 1,
            },
          };
        }
        throw new Error(`Unexpected Slack method: ${method}`);
      },
    } as unknown as SlackApiClient;
    const originalFetch = globalThis.fetch;
    const download = mock(() => {
      throw new Error("Unexpected file download");
    });
    globalThis.fetch = download as unknown as typeof fetch;

    try {
      const payload = await searchSlack({
        client,
        auth: { auth_type: "standard", token: "test-token" },
        options: {
          workspace_url: "https://workspace.slack.com",
          query: "worker",
          kind: "messages",
          limit: 20,
          metadata_only: true,
        },
      });

      expect(payload).toEqual({
        metadata_only: true,
        messages: [
          {
            channel_id: "C12345678",
            ts: "1700000000.000001",
            permalink,
          },
        ],
      });
      expect(calls.map((call) => call.method)).toEqual(["search.messages"]);
      expect(download).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("search rejects metadata-only contexts that cannot return canonical refs", async () => {
    const client = { api: async () => ({}) } as unknown as SlackApiClient;

    await expect(
      searchSlack({
        client,
        auth: { auth_type: "standard", token: "test-token" },
        options: {
          query: "worker",
          kind: "messages",
          channels: ["C12345678"],
          metadata_only: true,
        },
      }),
    ).rejects.toThrow("not supported with --channel fallback search");
  });

  test("search CLI preserves an empty messages array in metadata-only output", async () => {
    const calls: ApiCall[] = [];
    const client = {
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "search.messages") {
          return {
            messages: {
              matches: [],
              paging: { count: 20, page: 1, pages: 0, total: 0 },
              total: 0,
            },
          };
        }
        throw new Error(`Unexpected Slack method: ${method}`);
      },
    };
    const ctx = {
      effectiveWorkspaceUrl: () => "https://workspace.slack.com",
      assertWorkspaceSpecifiedForChannelNames: async () => {},
      withAutoRefresh: async (input: { work: () => Promise<unknown> }) => await input.work(),
      getClientForWorkspace: async () => ({
        client,
        auth: { auth_type: "standard", token: "test-token" },
        workspace_url: "https://workspace.slack.com",
      }),
      parseContentType: () => "any",
      errorMessage: (error: unknown) => String(error),
    } as unknown as CliContext;
    const program = new Command();
    registerSearchCommand({ program, ctx });
    const originalLog = console.log;
    const log = mock((_value: unknown) => {});
    console.log = log as typeof console.log;

    try {
      await program.parseAsync(["search", "messages", "no matches", "--metadata-only"], {
        from: "user",
      });

      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        metadata_only: true,
        messages: [],
      });
      expect(calls.map((call) => call.method)).toEqual(["search.messages"]);
    } finally {
      console.log = originalLog;
    }
  });
});
