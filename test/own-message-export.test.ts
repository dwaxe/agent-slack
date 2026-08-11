import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { exportOwnMessages, parseExactSlackTimestamp } from "../src/slack/own-message-export.ts";
import { canonicalSlackTextContentSha256 } from "../src/slack/content-identity.ts";

type ApiCall = { method: string; params: Record<string, unknown> };

function slackTs(iso: string, micros: string): string {
  return `${Math.floor(Date.parse(iso) / 1000)}.${micros}`;
}

describe("own-message export", () => {
  test("exports only exact-window self-authored channel text without hydrating messages", async () => {
    const oldest = slackTs("2026-07-12T12:00:00Z", "100000");
    const latest = slackTs("2026-08-11T12:00:00Z", "900000");
    const beforeOldest = slackTs("2026-07-12T12:00:00Z", "099999");
    const afterLatest = slackTs("2026-08-11T12:00:00Z", "900001");
    const middle = slackTs("2026-07-20T12:00:00Z", "200000");
    const publicRawText = "my own <https://example.com|link>";
    const calls: ApiCall[] = [];

    const client = {
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "auth.test") {
          return {
            team_id: "T12345678",
            user_id: "U12345678",
            url: "https://workspace.slack.com/",
          };
        }
        if (method === "search.messages") {
          const page = Number(params.page);
          if (page === 1) {
            return {
              messages: {
                paging: { page: 1, pages: 2 },
                matches: [
                  {
                    user_id: "U12345678",
                    ts: oldest,
                    channel: { id: "C11111111" },
                    text: publicRawText,
                    blocks: [{ type: "section", text: { type: "mrkdwn", text: "not mine" } }],
                    attachments: [{ text: "forwarded text is not mine" }],
                  },
                  {
                    user_id: "U99999999",
                    ts: middle,
                    channel: { id: "C11111111" },
                    text: "another author's text",
                  },
                  {
                    user_id: "U12345678",
                    ts: beforeOldest,
                    channel: { id: "C11111111" },
                    text: "too early",
                  },
                  {
                    user_id: "U12345678",
                    ts: middle,
                    channel: { id: "D11111111", is_im: true },
                    text: "direct message",
                  },
                  {
                    user_id: "U12345678",
                    ts: middle,
                    channel: { id: "G11111111" },
                    text: "private channel text",
                  },
                ],
              },
            };
          }
          return {
            messages: {
              paging: { page: 2, pages: 2 },
              matches: [
                {
                  user_id: "U12345678",
                  ts: oldest,
                  channel: { id: "C11111111" },
                  text: "",
                  permalink: "https://workspace.slack.com/archives/C11111111/p1",
                },
                {
                  user_id: "U12345678",
                  ts: middle,
                  channel: { id: "G22222222" },
                  text: "group direct message",
                },
                {
                  user: "U12345678",
                  ts: latest,
                  channel: { id: "C22222222" },
                  text: "inclusive latest",
                },
                {
                  user_id: "U12345678",
                  ts: afterLatest,
                  channel: { id: "C22222222" },
                  text: "too late",
                },
              ],
            },
          };
        }
        if (method === "conversations.info") {
          if (params.channel === "G11111111") {
            return { channel: { id: params.channel, is_group: true, is_mpim: false } };
          }
          if (params.channel === "G22222222") {
            return { channel: { id: params.channel, is_group: true, is_mpim: true } };
          }
        }
        throw new Error(`Unexpected API call: ${method}`);
      },
    };

    const result = await exportOwnMessages({
      client: client as never,
      workspaceUrl: "https://workspace.slack.com",
      oldest,
      latest,
    });

    expect(result).toEqual({
      schema_version: 1,
      complete: true,
      workspace_url: "https://workspace.slack.com",
      team_id: "T12345678",
      user_id: "U12345678",
      oldest,
      latest,
      messages: [
        {
          channel_id: "C11111111",
          ts: oldest,
          content: "my own [link](https://example.com)",
          content_sha256: createHash("sha256").update(publicRawText).digest("hex"),
          canonical_content_sha256: canonicalSlackTextContentSha256(publicRawText),
        },
        {
          channel_id: "G11111111",
          ts: middle,
          content: "private channel text",
          content_sha256: createHash("sha256").update("private channel text").digest("hex"),
          canonical_content_sha256: canonicalSlackTextContentSha256("private channel text"),
        },
        {
          channel_id: "C22222222",
          ts: latest,
          content: "inclusive latest",
          content_sha256: createHash("sha256").update("inclusive latest").digest("hex"),
          canonical_content_sha256: canonicalSlackTextContentSha256("inclusive latest"),
        },
      ],
    });

    const searches = calls.filter((call) => call.method === "search.messages");
    expect(searches).toHaveLength(2);
    expect(searches[0]?.params).toEqual({
      query: "from:<@U12345678> after:2026-07-11 before:2026-08-12",
      count: 100,
      page: 1,
      highlight: false,
      sort: "timestamp",
      sort_dir: "asc",
    });
    expect(calls.filter((call) => call.method === "conversations.info")).toEqual([
      { method: "conversations.info", params: { channel: "G11111111" } },
      { method: "conversations.info", params: { channel: "G22222222" } },
    ]);
    expect(calls.some((call) => call.method === "conversations.history")).toBe(false);
    expect(calls.some((call) => call.method === "files.info")).toBe(false);
    expect(result.messages[0]?.content).not.toContain("not mine");
    expect(result.messages[0]?.content).not.toContain("forwarded");
    expect(result.messages[0]?.content_sha256).not.toBe(
      createHash("sha256")
        .update(result.messages[0]?.content ?? "")
        .digest("hex"),
    );
  });

  test("marks a bounded export incomplete when the explicit page cap is reached", async () => {
    const oldest = slackTs("2026-08-01T00:00:00Z", "000001");
    const client = {
      api: async (method: string) => {
        if (method === "auth.test") {
          return {
            team_id: "T12345678",
            user_id: "U12345678",
            url: "https://workspace.slack.com/",
          };
        }
        return {
          messages: {
            paging: { page: 1, pages: 2 },
            matches: [
              {
                user_id: "U12345678",
                ts: oldest,
                channel: { id: "C11111111" },
                text: "first page",
              },
            ],
          },
        };
      },
    };

    const result = await exportOwnMessages({
      client: client as never,
      workspaceUrl: "https://workspace.slack.com",
      oldest,
      pageCap: 1,
    });

    expect(result.complete).toBe(false);
    expect(result.latest).toBeNull();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content_sha256).toBe(
      createHash("sha256").update("first page").digest("hex"),
    );
    expect(result.messages[0]?.canonical_content_sha256).toBe(
      canonicalSlackTextContentSha256("first page"),
    );
  });

  test("rejects malformed and reversed exact timestamp windows before Slack access", async () => {
    expect(() => parseExactSlackTimestamp("2026-08-01", "--oldest")).toThrow(
      "expected an exact Slack timestamp",
    );
    expect(() => parseExactSlackTimestamp("99999999999999999999.000001", "--oldest")).toThrow(
      "expected an exact Slack timestamp",
    );

    const client = {
      api: async () => {
        throw new Error("Slack should not be called");
      },
    };
    await expect(
      exportOwnMessages({
        client: client as never,
        workspaceUrl: "https://workspace.slack.com",
        oldest: "1800000000.000002",
        latest: "1800000000.000001",
      }),
    ).rejects.toThrow("--latest must be greater than or equal to --oldest");
  });

  test("rejects credentials authenticated to a different workspace before searching", async () => {
    const calls: string[] = [];
    const client = {
      api: async (method: string) => {
        calls.push(method);
        return {
          team_id: "T99999999",
          user_id: "U12345678",
          url: "https://other.slack.com/",
        };
      },
    };

    await expect(
      exportOwnMessages({
        client: client as never,
        workspaceUrl: "https://workspace.slack.com",
        oldest: "1800000000.000001",
      }),
    ).rejects.toThrow("different workspace");
    expect(calls).toEqual(["auth.test"]);
  });
});
