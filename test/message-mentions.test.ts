import { describe, expect, test } from "bun:test";
import type { CliContext } from "../src/cli/context.ts";
import { handleMessageList } from "../src/cli/message-read-actions.ts";
import { toCompactMessage } from "../src/slack/message-compact.ts";
import type { SlackMessageSummary } from "../src/slack/messages.ts";

function compact(input: Partial<SlackMessageSummary>, includeMentionMetadata = true) {
  return toCompactMessage(
    {
      channel_id: "C12345678",
      ts: "1700000000.000001",
      text: "",
      markdown: "",
      ...input,
    },
    { includeMentionMetadata },
  );
}

describe("compact message notification mentions", () => {
  test("omits mention evidence unless explicitly requested", () => {
    const message = compact({ text: "Ping <@U11111111>" }, false);

    expect("mention_evidence" in message).toBe(false);
  });

  test("collects real and labeled raw mentions in sorted deduplicated arrays", () => {
    const message = compact({
      text: [
        "Ping <@W22222222|alice> and <!subteam^S22222222|@oncall>",
        "Then <@U11111111> and <!subteam^S11111111> and <@W22222222>",
      ].join("\n"),
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: ["U11111111", "W22222222"],
      usergroup_ids: ["S11111111", "S22222222"],
    });
  });

  test("excludes escaped literals, HTML literals, code, and blockquotes", () => {
    const message = compact({
      text: [
        String.raw`escaped \<@U11111111> and \<!subteam^S11111111>`,
        "entities &lt;@U22222222&gt; and &lt;!subteam^S22222222&gt;",
        "inline `<@U33333333> <!subteam^S33333333>`",
        "```",
        "<@U44444444> <!subteam^S44444444>",
        "```",
        "> quoted <@U55555555> <!subteam^S55555555>",
        "real <@U99999999> <!subteam^S99999999>",
        ">>> multiline quoted <@U66666666> <!subteam^S66666666>",
        "still quoted <@U77777777> <!subteam^S77777777>",
      ].join("\n"),
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: ["U99999999"],
      usergroup_ids: ["S99999999"],
    });
  });

  test("excludes same-line and unclosed fenced-code mentions", () => {
    const sameLine = compact({
      text: [
        "before <@U11111111> ``` hidden <@U22222222> ``` after <!subteam^S11111111>",
        "next <@U33333333>",
      ].join("\n"),
    });
    const unclosed = compact({
      text: [
        "before <@U44444444>",
        "``` hidden <!subteam^S44444444>",
        "still hidden <@U55555555>",
      ].join("\n"),
    });

    expect(sameLine.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: ["U11111111", "U33333333"],
      usergroup_ids: ["S11111111"],
    });
    expect(unclosed.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: ["U44444444"],
      usergroup_ids: [],
    });
  });

  test("rejects IDs beyond the consumer's supported length", () => {
    const message = compact({
      text: "<@U12345678901234567890> <!subteam^S12345678901234567890>",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "user", user_id: "U12345678901234567890" },
                { type: "usergroup", usergroup_id: "S12345678901234567890" },
              ],
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

  test("collects only mrkdwn from top-level section and context fields", () => {
    const message = compact({
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Owner <@U11111111>" },
          fields: [
            { type: "mrkdwn", text: "Team <!subteam^S11111111>" },
            { type: "plain_text", text: "Literal <@U22222222>" },
          ],
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: "Backup <@W33333333|backup>" },
            { type: "plain_text", text: "Literal <!subteam^S22222222>" },
          ],
        },
        {
          type: "header",
          text: { type: "mrkdwn", text: "Ignored <@U44444444>" },
        },
      ],
    });

    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: false,
      user_ids: ["U11111111", "W33333333"],
      usergroup_ids: ["S11111111"],
    });
  });

  test("collects structural rich-text mentions in sections and lists", () => {
    const message = compact({
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "user", user_id: "W22222222" },
                { type: "usergroup", usergroup_id: "S22222222" },
                { type: "text", text: "<@U99999999> <!subteam^S99999999>" },
              ],
            },
            {
              type: "rich_text_list",
              style: "bullet",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    { type: "user", user_id: "U11111111" },
                    { type: "usergroup", usergroup_id: "S11111111" },
                  ],
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
      user_ids: ["U11111111", "W22222222"],
      usergroup_ids: ["S11111111", "S22222222"],
    });
  });

  test("excludes structural mentions in rich-text code and quotes", () => {
    const message = compact({
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_preformatted",
              elements: [
                { type: "user", user_id: "U11111111" },
                { type: "usergroup", usergroup_id: "S11111111" },
              ],
            },
            {
              type: "rich_text_quote",
              elements: [
                { type: "user", user_id: "U22222222" },
                { type: "usergroup", usergroup_id: "S22222222" },
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
      usergroup_ids: [],
    });
  });

  test("never derives direct mentions from forwarded attachments", () => {
    const message = compact({
      attachments: [
        {
          is_share: true,
          text: "Forwarded <@U11111111> <!subteam^S11111111>",
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: "<@U22222222> <!subteam^S22222222>" },
            },
          ],
          message_blocks: [
            {
              message: {
                blocks: [
                  {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements: [
                          { type: "user", user_id: "U33333333" },
                          { type: "usergroup", usergroup_id: "S33333333" },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(message.content).toContain("Forwarded");
    expect(message.mention_evidence).toEqual({
      schema: 2,
      complete: true,
      user_ids: [],
      usergroup_ids: [],
    });
  });

  test("message list preserves the complete evidence schema, including empty arrays", async () => {
    const root = {
      ts: "1700000000.000001",
      text: "Ping <!subteam^S11111111>",
      user: "U99999999",
    };
    const reply = {
      ts: "1700000001.000002",
      thread_ts: root.ts,
      text: "No notification mentions",
      user: "U88888888",
    };
    const client = {
      api: async (method: string) => {
        if (method === "conversations.history") {
          return { messages: [root] };
        }
        if (method === "conversations.replies") {
          return { messages: [reply, root] };
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

    const payload = await handleMessageList({
      ctx,
      targetInput: "https://workspace.slack.com/archives/C12345678/p1700000000000001",
      options: {
        maxBodyChars: "8000",
        includeMentionMetadata: true,
      },
    });

    expect(payload.messages).toEqual([
      {
        ts: root.ts,
        author: { user_id: "U99999999" },
        content: "Ping <!subteam^S11111111>",
        mention_evidence: {
          schema: 2,
          complete: true,
          user_ids: [],
          usergroup_ids: ["S11111111"],
        },
      },
      {
        ts: reply.ts,
        author: { user_id: "U88888888" },
        content: reply.text,
        mention_evidence: {
          schema: 2,
          complete: true,
          user_ids: [],
          usergroup_ids: [],
        },
      },
    ]);
  });
});
