import { describe, expect, test } from "bun:test";
import { messageSummaryFromApiMessage } from "../src/slack/search-messages.ts";
import { fetchChannelHistory, fetchMessage, fetchThread } from "../src/slack/messages.ts";
import { toSlackMessageSummary } from "../src/slack/message-api-parsing.ts";

describe("Slack message mrkdwn conversion", () => {
  test("can bypass Markdown rendering while preserving raw mention surfaces", () => {
    const blocks = [{ type: "rich_text", elements: [] }];
    const attachments = [{ text: "attachment" }];
    const message = toSlackMessageSummary({
      channelId: "C12345678",
      message: {
        ts: "1.000001",
        text: "<https://example.com|rendered label>",
        blocks,
        attachments,
      },
      renderMarkdown: false,
    });

    expect(message.markdown).toBe("");
    expect(message).toMatchObject({
      text: "<https://example.com|rendered label>",
      blocks,
      attachments,
    });
  });

  test("fetchMessage preserves mrkdwn false from conversations.history", async () => {
    const client = {
      api: async () => ({
        messages: [{ ts: "1.000001", text: "<@U11111111>", mrkdwn: false }],
      }),
    };

    const message = await fetchMessage(client as never, {
      ref: {
        workspace_url: "https://workspace.slack.com",
        channel_id: "C12345678",
        message_ts: "1.000001",
        raw: "test",
      },
    });

    expect(message.mrkdwn).toBe(false);
  });

  test("channel history preserves false, true, malformed, and omitted mrkdwn values", async () => {
    const client = {
      api: async () => ({
        messages: [
          { ts: "4.000004", text: "default" },
          { ts: "3.000003", text: "future", mrkdwn: "future-mode" },
          { ts: "2.000002", text: "enabled", mrkdwn: true },
          { ts: "1.000001", text: "disabled", mrkdwn: false },
        ],
      }),
    };

    const messages = await fetchChannelHistory(client as never, {
      channelId: "C12345678",
      limit: 4,
    });

    expect(messages.map((message) => message.mrkdwn)).toEqual([
      false,
      true,
      "future-mode",
      undefined,
    ]);
  });

  test("thread replies preserve false, true, and omitted mrkdwn values", async () => {
    const client = {
      api: async () => ({
        messages: [
          { ts: "3.000003", text: "default" },
          { ts: "2.000002", text: "enabled", mrkdwn: true },
          { ts: "1.000001", text: "disabled", mrkdwn: false },
        ],
      }),
    };

    const messages = await fetchThread(client as never, {
      channelId: "C12345678",
      threadTs: "1.000001",
    });

    expect(messages.map((message) => message.mrkdwn)).toEqual([false, true, undefined]);
  });

  test("channel-search fallback conversion preserves mrkdwn and raw source containers", () => {
    const blocks = { malformed: "future block container" };
    const attachments = { malformed: "future attachment container" };

    const message = messageSummaryFromApiMessage("C12345678", {
      ts: "1.000001",
      text: "<@U11111111>",
      mrkdwn: false,
      blocks,
      attachments,
    });

    expect(message).toMatchObject({ mrkdwn: false, blocks, attachments });
  });
});
