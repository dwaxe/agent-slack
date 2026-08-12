import { describe, expect, test } from "bun:test";
import { fetchThread } from "../src/slack/messages.ts";

describe("fetchThread", () => {
  test("returns the thread root and replies in chronological order", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client = {
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return {
          messages: [
            { ts: "2.000002", thread_ts: "1.000001", text: "reply", user: "U22222222" },
            { ts: "1.000001", text: "root", user: "U11111111" },
          ],
        };
      },
    };

    const messages = await fetchThread(client as never, {
      channelId: "C12345678",
      threadTs: "1.000001",
    });

    expect(calls).toEqual([
      {
        method: "conversations.replies",
        params: {
          channel: "C12345678",
          ts: "1.000001",
          limit: 200,
          cursor: undefined,
          include_all_metadata: undefined,
        },
      },
    ]);
    expect(messages.map(({ ts, text }) => ({ ts, text }))).toEqual([
      { ts: "1.000001", text: "root" },
      { ts: "2.000002", text: "reply" },
    ]);
  });

  test("proves a complete thread across strict cursor pages", async () => {
    const threadTs = "1700000000.000001";
    const calls: Record<string, unknown>[] = [];
    const client = {
      api: async (_method: string, params: Record<string, unknown>) => {
        calls.push(params);
        if (params.cursor === undefined) {
          return {
            messages: [
              {
                ts: threadTs,
                text: "root",
                user: "U11111111",
                reply_count: 2,
              },
              {
                ts: "1700000001.000002",
                thread_ts: threadTs,
                text: "first reply",
                user: "U22222222",
              },
            ],
            has_more: true,
            response_metadata: { next_cursor: "cursor-1" },
          };
        }
        return {
          messages: [
            {
              ts: "1700000002.000003",
              thread_ts: threadTs,
              text: "second reply",
              bot_id: "B33333333",
            },
          ],
          has_more: false,
          response_metadata: { next_cursor: "" },
        };
      },
    };

    const messages = await fetchThread(client as never, {
      channelId: "C12345678",
      threadTs,
      requireComplete: true,
    });

    expect(calls.map((call) => call.cursor)).toEqual([undefined, "cursor-1"]);
    expect(messages.map((message) => message.ts)).toEqual([
      threadTs,
      "1700000001.000002",
      "1700000002.000003",
    ]);
  });

  test("rejects malformed strict pages and incoherent pagination", async () => {
    const threadTs = "1700000000.000001";
    const root = { ts: threadTs, text: "root" };
    const cases: { response: Record<string, unknown>; error: string }[] = [
      {
        response: { messages: { ts: threadTs }, has_more: false },
        error: "malformed messages page",
      },
      {
        response: { messages: [root, null], has_more: false },
        error: "non-object thread message",
      },
      {
        response: { messages: [root], has_more: "false" },
        error: "boolean has_more",
      },
      {
        response: { messages: [root], has_more: true, response_metadata: {} },
        error: "inconsistent has_more and next_cursor",
      },
      {
        response: {
          messages: [root],
          has_more: false,
          response_metadata: { next_cursor: "unexpected" },
        },
        error: "inconsistent has_more and next_cursor",
      },
      {
        response: {
          messages: [root],
          has_more: false,
          response_metadata: { next_cursor: 123 },
        },
        error: "non-string next_cursor",
      },
    ];

    for (const testCase of cases) {
      const client = { api: async () => testCase.response };
      await expect(
        fetchThread(client as never, {
          channelId: "C12345678",
          threadTs,
          requireComplete: true,
        }),
      ).rejects.toThrow(testCase.error);
    }
  });

  test("rejects malformed mention-bearing fields before message normalization", async () => {
    const threadTs = "1700000000.000001";
    const cases: { message: Record<string, unknown>; error: string }[] = [
      {
        message: { ts: threadTs, text: null },
        error: "message with malformed text",
      },
      {
        message: { ts: threadTs, text: "root", user: "not-a-user" },
        error: "canonical user ID",
      },
      {
        message: { ts: threadTs, text: "root" },
        error: "canonical author identity",
      },
      {
        message: { ts: threadTs, text: "root", bot_id: "not-a-bot" },
        error: "canonical bot ID",
      },
      {
        message: {
          ts: threadTs,
          text: "root",
          user: "U11111111",
          thread_ts: 1700000000,
        },
        error: "malformed thread_ts",
      },
      {
        message: {
          ts: threadTs,
          text: "root",
          user: "U11111111",
          thread_ts: "1700000000.1",
        },
        error: "malformed thread_ts",
      },
    ];

    for (const testCase of cases) {
      const client = {
        api: async () => ({
          messages: [testCase.message],
          has_more: false,
          response_metadata: { next_cursor: "" },
        }),
      };
      await expect(
        fetchThread(client as never, {
          channelId: "C12345678",
          threadTs,
          requireComplete: true,
          includeFiles: false,
        }),
      ).rejects.toThrow(testCase.error);
    }
  });

  test("rejects repeated cursors before treating a partial thread as complete", async () => {
    const threadTs = "1700000000.000001";
    let callCount = 0;
    const client = {
      api: async () => {
        callCount += 1;
        return {
          messages:
            callCount === 1
              ? [{ ts: threadTs, text: "root", user: "U11111111" }]
              : [
                  {
                    ts: "1700000001.000002",
                    thread_ts: threadTs,
                    text: "reply",
                    user: "U22222222",
                  },
                ],
          has_more: true,
          response_metadata: { next_cursor: "repeated-cursor" },
        };
      },
    };

    await expect(
      fetchThread(client as never, {
        channelId: "C12345678",
        threadTs,
        requireComplete: true,
      }),
    ).rejects.toThrow("repeated a pagination cursor");
    expect(callCount).toBe(2);
  });

  test("rejects duplicate message timestamps across pages", async () => {
    const threadTs = "1700000000.000001";
    let callCount = 0;
    const client = {
      api: async () => {
        callCount += 1;
        return callCount === 1
          ? {
              messages: [{ ts: threadTs, text: "root", user: "U11111111" }],
              has_more: true,
              response_metadata: { next_cursor: "cursor-1" },
            }
          : {
              messages: [{ ts: threadTs, text: "duplicate root", user: "U11111111" }],
              has_more: false,
              response_metadata: { next_cursor: "" },
            };
      },
    };

    await expect(
      fetchThread(client as never, {
        channelId: "C12345678",
        threadTs,
        requireComplete: true,
      }),
    ).rejects.toThrow(`duplicate message timestamp ${threadTs}`);
  });

  test("rejects a terminal page that omits the requested thread root", async () => {
    const threadTs = "1700000000.000001";
    const client = {
      api: async () => ({
        messages: [
          {
            ts: "1700000001.000002",
            thread_ts: threadTs,
            text: "orphaned reply",
            user: "U11111111",
          },
        ],
        has_more: false,
        response_metadata: { next_cursor: "" },
      }),
    };

    await expect(
      fetchThread(client as never, {
        channelId: "C12345678",
        threadTs,
        requireComplete: true,
      }),
    ).rejects.toThrow("did not return the requested thread root");
  });
});
