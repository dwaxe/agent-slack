import { describe, expect, test } from "bun:test";
import { toCompactMessage } from "../src/slack/message-compact.ts";
import type { SlackMessageSummary } from "../src/slack/messages.ts";

const SELF_USER_ID = "U11111111";
const GROUP_ID = "S22222222";
const MESSAGE_REFERENCE = {
  type: "message_mention",
  author_id: SELF_USER_ID,
  channel_id: "C12345678",
  message_ts: "1700000000.000001",
  text: `Literal <@${SELF_USER_ID}> <!subteam^S99999999>`,
  url: "https://workspace.slack.com/archives/C12345678/p1700000000000001",
};

function compact(input: Partial<SlackMessageSummary>) {
  return toCompactMessage(
    {
      channel_id: "C12345678",
      ts: "1700000000.000002",
      text: "",
      markdown: "",
      ...input,
    },
    { includeMentionMetadata: true },
  );
}

function section(elements: unknown[]) {
  return [
    {
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements }],
    },
  ];
}

describe("message reference mention evidence", () => {
  test("accepts a message reference while excluding its author, label, and message unfurl", () => {
    const message = compact({
      blocks: section([MESSAGE_REFERENCE, { type: "usergroup", usergroup_id: GROUP_ID }]),
      attachments: [
        {
          is_msg_unfurl: true,
          author_id: SELF_USER_ID,
          text: `<@${SELF_USER_ID}>`,
          mrkdwn_in: ["text"],
          message_blocks: [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "user", user_id: SELF_USER_ID }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: [],
      usergroup_ids: [GROUP_ID],
    });
  });

  test("retains a direct self mention beside a non-notifying message reference", () => {
    const message = compact({
      blocks: section([
        MESSAGE_REFERENCE,
        { type: "user", user_id: SELF_USER_ID },
        { type: "usergroup", usergroup_id: GROUP_ID },
      ]),
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: [SELF_USER_ID],
      usergroup_ids: [GROUP_ID],
    });
  });

  test("accepts canonical GovSlack, Grid author, and private-channel references", () => {
    const message = compact({
      blocks: section([
        {
          ...MESSAGE_REFERENCE,
          author_id: "W11111111",
          channel_id: "G12345678",
          url: "https://workspace.slack-gov.com/archives/G12345678/p1700000000000001",
        },
      ]),
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: [],
      usergroup_ids: [],
    });
  });

  test("fails closed for missing, malformed, extended, or mismatched reference data", () => {
    const missingFields = Object.keys(MESSAGE_REFERENCE).map((key) => {
      const value: Record<string, unknown> = { ...MESSAGE_REFERENCE };
      delete value[key];
      return value;
    });
    const malformedFields = [
      { author_id: false },
      { author_id: "B11111111" },
      { author_id: "Ushort" },
      { author_id: " U11111111" },
      { channel_id: false },
      { channel_id: "U11111111" },
      { channel_id: "Cshort" },
      { message_ts: 1700000000.000001 },
      { message_ts: "01700000000.000001" },
      { message_ts: "1700000000.1" },
      { message_ts: "1700000000.000001\n" },
      { text: null },
      { url: null },
      { url: "https://workspace.slack.com/archives/G12345678/p1700000000000001" },
      { url: "https://workspace.slack.com/archives/C12345678/p1700000000000002" },
      { url: "http://workspace.slack.com/archives/C12345678/p1700000000000001" },
      { url: "https://workspace.slack.com.example.com/archives/C12345678/p1700000000000001" },
      { url: "https://user@workspace.slack.com/archives/C12345678/p1700000000000001" },
      { url: "https://workspace.slack.com:443/archives/C12345678/p1700000000000001" },
      { url: "https://workspace.slack.com/archives/C12345678/p1700000000000001?future=1" },
      { url: "https://workspace.slack.com/archives/C12345678/p1700000000000001#reference" },
      { url: "https://workspace.slack.com/archives/C12345678/./p1700000000000001" },
      { url: " https://workspace.slack.com/archives/C12345678/p1700000000000001" },
      { future_notification_target: { user_id: SELF_USER_ID } },
      { style: { bold: true } },
    ].map((fields) => ({ ...MESSAGE_REFERENCE, ...fields }));

    for (const reference of [...missingFields, ...malformedFields]) {
      const message = compact({ blocks: section([reference]) });

      expect(message.mention_evidence).toEqual({
        schema: 2,
        complete: false,
        user_ids: [],
        usergroup_ids: [],
      });
    }
  });

  test("keeps quote and code contents excluded while validating reference containers", () => {
    const message = compact({
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_list",
              style: "bullet",
              elements: [{ type: "rich_text_section", elements: [MESSAGE_REFERENCE] }],
            },
            {
              type: "rich_text_quote",
              elements: [MESSAGE_REFERENCE, { type: "user", user_id: SELF_USER_ID }],
            },
            {
              type: "rich_text_preformatted",
              elements: [{ type: "user", user_id: SELF_USER_ID }],
            },
          ],
        },
      ],
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: [],
      usergroup_ids: [],
    });

    const unsupportedCodeReference = compact({
      blocks: [
        {
          type: "rich_text",
          elements: [{ type: "rich_text_preformatted", elements: [MESSAGE_REFERENCE] }],
        },
      ],
    });
    expect(unsupportedCodeReference.mention_evidence?.complete).toBe(false);
  });
});
