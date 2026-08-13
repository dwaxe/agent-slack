import { describe, expect, test } from "bun:test";
import { toCompactMessage } from "../src/slack/message-compact.ts";
import type { SlackMessageSummary } from "../src/slack/messages.ts";

function compact(input: Partial<SlackMessageSummary>) {
  return toCompactMessage(
    {
      channel_id: "C12345678",
      ts: "1700000000.000001",
      text: "",
      markdown: "",
      ...input,
    },
    { includeMentionMetadata: true },
  );
}

describe("attachment mention evidence", () => {
  test("accepts documented attachment mentions and opaque app-unfurl provider data", () => {
    const message = compact({
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "usergroup", usergroup_id: "S11111111" },
                {
                  type: "attachment_mention",
                  url: "https://github.com/example/repo/pull/42",
                  text: "Literal <@U99999999> <!subteam^S99999999>",
                  app_id: "A12345678",
                  entity_id: "pull-request-42",
                  icon_url: "https://example.com/icon.png",
                  channel_id: "C12345678",
                  ts: "1700000000.000001",
                  icon_name: "github",
                  reference_object_type: "pull_request",
                  product_name: "GitHub",
                  full_size_preview_enabled: true,
                  style: {
                    bold: true,
                    client_highlight: false,
                    highlight: true,
                    italic: false,
                    strike: false,
                    underline: true,
                    unlink: false,
                  },
                },
                { type: "usergroup", usergroup_id: "S22222222" },
              ],
            },
          ],
        },
      ],
      attachments: [
        {
          app_id: "A12345678",
          app_unfurl_url: "https://github.com/example/repo/pull/42",
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: "Reference <@U88888888>" },
            },
          ],
          bot_id: "B12345678",
          bot_team_id: "T12345678",
          color: "#000000",
          fallback: "Literal <!subteam^S88888888>",
          from_url: "https://github.com/example/repo/pull/42",
          id: 1,
          is_app_unfurl: true,
          work_object_entity: {
            type: "pull_request",
            owner: { user_id: "U77777777" },
          },
        },
      ],
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: [],
      usergroup_ids: ["S11111111", "S22222222"],
    });
  });

  test("fails closed for malformed or extended attachment mentions", () => {
    const malformedElements = [
      { type: "attachment_mention" },
      { type: "attachment_mention", url: 42 },
      { type: "attachment_mention", url: "https://example.com", text: false },
      {
        type: "attachment_mention",
        url: "https://example.com",
        full_size_preview_enabled: "true",
      },
      { type: "attachment_mention", url: "https://example.com", style: null },
      { type: "attachment_mention", url: "https://example.com", style: [] },
      {
        type: "attachment_mention",
        url: "https://example.com",
        style: { bold: "true" },
      },
      {
        type: "attachment_mention",
        url: "https://example.com",
        style: { code: true },
      },
      {
        type: "attachment_mention",
        url: "https://example.com",
        future_notification_target: { user_id: "U11111111" },
      },
    ];

    for (const element of malformedElements) {
      const message = compact({
        blocks: [
          {
            type: "rich_text",
            elements: [{ type: "rich_text_section", elements: [element] }],
          },
        ],
      });

      expect(message.mention_evidence?.complete).toBe(false);
    }
  });

  test("only trusts work-object data behind a valid app-unfurl subtype", () => {
    const unsafeAttachments = [
      {
        is_app_unfurl: true,
        is_future_unfurl: true,
        work_object_entity: { user_id: "U11111111" },
      },
      {
        is_app_unfurl: true,
        is_share: "true",
        work_object_entity: { user_id: "U11111111" },
      },
      {
        is_app_unfurl: "true",
        work_object_entity: { user_id: "U11111111" },
      },
      {
        is_app_unfurl: true,
        future_notification_target: { user_id: "U11111111" },
      },
      {
        is_app_unfurl: true,
        work_object_entity: [],
      },
      {
        is_app_unfurl: true,
        work_object_entity: "future-shape",
      },
      {
        is_app_unfurl: false,
        work_object_entity: { user_id: "U11111111" },
      },
      {
        is_future_unfurl: false,
        work_object_entity: { user_id: "U11111111" },
      },
      { work_object_entity: { user_id: "U11111111" } },
      {
        message_blocks: [],
        work_object_entity: { user_id: "U11111111" },
      },
      ...[
        "is_share",
        "is_file_attachment",
        "is_msg_unfurl",
        "is_reply_unfurl",
        "is_thread_root_unfurl",
      ].map((subtype) => ({
        [subtype]: true,
        work_object_entity: { user_id: "U11111111" },
      })),
    ];

    for (const attachment of unsafeAttachments) {
      const message = compact({ attachments: [attachment] });

      expect(message.mention_evidence).toEqual({
        schema: 2,
        complete: false,
        user_ids: [],
        usergroup_ids: [],
      });
    }
  });

  test("accepts attachment mentions only in documented rich-text containers", () => {
    const attachmentMention = {
      type: "attachment_mention",
      url: "https://example.com/reference",
    };
    const allowedContainers = [
      {
        type: "rich_text_section",
        elements: [attachmentMention],
      },
      {
        type: "rich_text_list",
        style: "bullet",
        elements: [{ type: "rich_text_section", elements: [attachmentMention] }],
      },
      {
        type: "rich_text_quote",
        elements: [attachmentMention],
      },
    ];

    for (const container of allowedContainers) {
      const message = compact({
        blocks: [{ type: "rich_text", elements: [container] }],
      });

      expect(message.mention_evidence?.complete).toBe(true);
    }

    const preformatted = compact({
      blocks: [
        {
          type: "rich_text",
          elements: [{ type: "rich_text_preformatted", elements: [attachmentMention] }],
        },
      ],
    });

    expect(preformatted.mention_evidence?.complete).toBe(false);
  });
});
