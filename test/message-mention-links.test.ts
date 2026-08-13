import { describe, expect, test } from "bun:test";
import { toCompactMessage } from "../src/slack/message-compact.ts";
import type { SlackMessageSummary } from "../src/slack/messages.ts";

function compact(blocks: unknown) {
  return toCompactMessage(
    {
      channel_id: "C12345678",
      ts: "1700000000.000001",
      text: "",
      markdown: "",
      blocks,
    } satisfies SlackMessageSummary,
    { includeMentionMetadata: true },
  );
}

function linkBlock(link: Record<string, unknown>) {
  return [
    {
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [link] }],
    },
  ];
}

describe("rich-text link mention evidence", () => {
  test("accepts Slack's truncated metadata without treating link labels as mentions", () => {
    const message = compact([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "usergroup", usergroup_id: "S11111111" },
              {
                type: "link",
                url: "https://github.com/org/repo/pull/42",
                text: "Literal <@U22222222>",
                truncated: true,
              },
            ],
          },
          {
            type: "rich_text_quote",
            elements: [
              {
                type: "link",
                url: "https://github.com/org/repo/pull/43",
                text: "Literal <!subteam^S22222222>",
                truncated: false,
              },
            ],
          },
        ],
      },
    ]);

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: [],
      usergroup_ids: ["S11111111"],
    });
  });

  test("fails closed for malformed truncated metadata", () => {
    for (const truncated of ["true", 1, null, {}, []]) {
      const message = compact(
        linkBlock({
          type: "link",
          url: "https://github.com/org/repo/pull/42",
          truncated,
        }),
      );

      expect(message.mention_evidence?.complete).toBe(false);
    }
  });

  test("fails closed for unknown link metadata", () => {
    const message = compact(
      linkBlock({
        type: "link",
        url: "https://github.com/org/repo/pull/42",
        truncated: true,
        future_link_metadata: { user_id: "U11111111" },
      }),
    );

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: false,
      user_ids: [],
      usergroup_ids: [],
    });
  });
});
