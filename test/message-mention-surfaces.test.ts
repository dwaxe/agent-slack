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

describe("notification mention source completeness", () => {
  test("mrkdwn false excludes top-level literals while blocks remain structural evidence", () => {
    const message = compact({
      text: "Literal <@U11111111> <!subteam^S11111111>",
      mrkdwn: false,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Direct <@W22222222> <!subteam^S22222222>",
          },
        },
      ],
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: ["W22222222"],
      usergroup_ids: ["S22222222"],
    });
  });

  test("mrkdwn true and omitted both include top-level direct mentions", () => {
    const enabled = compact({ text: "Ping <@U11111111>", mrkdwn: true });
    const defaulted = compact({ text: "Ping <!subteam^S11111111>" });

    expect(enabled.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: ["U11111111"],
      usergroup_ids: [],
    });
    expect(defaulted.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: [],
      usergroup_ids: ["S11111111"],
    });
  });

  test("marks evidence incomplete instead of defaulting malformed mrkdwn metadata", () => {
    const message = compact({
      text: "Potential <@U11111111>",
      mrkdwn: "future-mode",
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: false,
      user_ids: ["U11111111"],
      usergroup_ids: [],
    });
  });

  test("collects only explicitly mrkdwn-enabled normal legacy attachment fields", () => {
    const message = compact({
      attachments: [
        {
          mrkdwn_in: ["pretext", "text", "fields"],
          pretext: "Owner <@W22222222>",
          text: "Team <!subteam^S22222222>",
          title: "Plain <@U99999999>",
          fallback: "Plain <!subteam^S99999999>",
          fields: [
            {
              title: "Plain <@U88888888>",
              value: "Backup <@U11111111> <!subteam^S11111111>",
            },
          ],
        },
      ],
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: ["U11111111", "W22222222"],
      usergroup_ids: ["S11111111", "S22222222"],
    });
  });

  test("treats legacy attachment text as plain when mrkdwn_in omits it", () => {
    const message = compact({
      attachments: [
        {
          pretext: "Literal <@U11111111>",
          text: "Literal <!subteam^S11111111>",
          fields: [{ value: "Literal <@W22222222>" }],
        },
      ],
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: [],
      usergroup_ids: [],
    });
  });

  test("excludes forwarded and unfurled attachment bodies even with mrkdwn_in", () => {
    const message = compact({
      attachments: [
        {
          is_share: true,
          mrkdwn_in: ["text"],
          text: "Forwarded <@U11111111> <!subteam^S11111111>",
          message_blocks: [{ message: { text: "<@U22222222>" } }],
        },
        {
          is_msg_unfurl: true,
          mrkdwn_in: ["pretext"],
          pretext: "Unfurled <@W33333333> <!subteam^S33333333>",
        },
      ],
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: [],
      usergroup_ids: [],
    });
  });

  test("collects rich-text mentions from table, data table, and task card blocks", () => {
    const richText = (element: Record<string, unknown>) => ({
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [element] }],
    });
    const message = compact({
      blocks: [
        {
          type: "table",
          column_settings: [{ is_wrapped: true }, null, { align: "right" }],
          rows: [
            [
              { type: "raw_text", text: "Literal <@U99999999>" },
              richText({ type: "user", user_id: "U11111111" }),
            ],
          ],
        },
        {
          type: "data_table",
          caption: "Direct targets",
          rows: [
            [{ type: "raw_text", text: "Team" }],
            [richText({ type: "usergroup", usergroup_id: "S11111111" })],
          ],
        },
        {
          type: "task_card",
          task_id: "task-1",
          title: "Literal <@U88888888>",
          details: richText({ type: "user", user_id: "W22222222" }),
          output: richText({ type: "usergroup", usergroup_id: "S22222222" }),
          sources: [
            {
              type: "url",
              url: "https://example.com/source",
              text: "Literal <@U77777777>",
            },
          ],
        },
      ],
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: ["U11111111", "W22222222"],
      usergroup_ids: ["S11111111", "S22222222"],
    });
  });

  test("marks evidence incomplete for unknown blocks and attachment subtypes", () => {
    const message = compact({
      text: "Known <!subteam^S11111111>",
      blocks: [
        {
          type: "future_notification_block",
          content: { type: "user", user_id: "U22222222" },
        },
      ],
      attachments: [
        {
          is_future_unfurl: true,
          mrkdwn_in: ["text"],
          text: "Unknown <@U33333333>",
        },
      ],
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: false,
      user_ids: [],
      usergroup_ids: ["S11111111"],
    });
  });

  test("marks evidence incomplete for unsupported nested semantic shapes", () => {
    const message = compact({
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "future_user", user_id: "U11111111" }],
            },
          ],
        },
        {
          type: "table",
          rows: [[{ type: "future_rich_cell", value: "<!subteam^S11111111>" }]],
        },
      ],
      attachments: [
        {
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: "<@U22222222>" },
            },
          ],
        },
      ],
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: false,
      user_ids: [],
      usergroup_ids: [],
    });
  });

  test("marks future fields on parsed task and table shapes incomplete", () => {
    const message = compact({
      blocks: [
        {
          type: "table",
          rows: [[{ type: "raw_text", text: "known" }]],
          future_cells: [{ type: "user", user_id: "U11111111" }],
        },
        {
          type: "task_card",
          task_id: "task-1",
          title: "Known title",
          future_details: {
            type: "rich_text",
            elements: [],
          },
        },
      ],
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: false,
      user_ids: [],
      usergroup_ids: [],
    });
  });
});
