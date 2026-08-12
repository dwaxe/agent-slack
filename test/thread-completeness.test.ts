import { describe, expect, test } from "bun:test";
import { fetchThread } from "../src/slack/messages.ts";

const threadTs = "1700000000.000001";

function strictThreadClient(messages: Record<string, unknown>[]) {
  return {
    api: async () => ({
      messages,
      has_more: false,
      response_metadata: { next_cursor: "" },
    }),
  };
}

function fetchStrictThread(messages: Record<string, unknown>[]) {
  return fetchThread(strictThreadClient(messages) as never, {
    channelId: "C12345678",
    threadTs,
    requireComplete: true,
  });
}

describe("strict thread reply count completeness", () => {
  test("rejects malformed root reply counts", async () => {
    for (const replyCount of [null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0"]) {
      await expect(
        fetchStrictThread([
          {
            ts: threadTs,
            text: "root",
            user: "U12345678",
            reply_count: replyCount,
          },
        ]),
      ).rejects.toThrow("malformed root reply_count");
    }
  });

  test("rejects terminal boundaries that disagree with root reply_count", async () => {
    const cases = [
      {
        reported: 1,
        messages: [
          {
            ts: threadTs,
            text: "root",
            user: "U12345678",
            reply_count: 1,
          },
        ],
      },
      {
        reported: 0,
        messages: [
          {
            ts: threadTs,
            text: "root",
            user: "U12345678",
            reply_count: 0,
          },
          {
            ts: "1700000001.000002",
            thread_ts: threadTs,
            text: "reply",
            user: "U87654321",
          },
        ],
      },
    ];

    for (const testCase of cases) {
      await expect(fetchStrictThread(testCase.messages)).rejects.toThrow(
        `the root reports ${String(testCase.reported)}`,
      );
    }
  });
});
