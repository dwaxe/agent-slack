import { afterEach, describe, expect, mock, test } from "bun:test";
import { ErrorCode } from "@slack/web-api";
import { SlackApiClient, isSlackRateLimitedError } from "../src/slack/client.ts";
import { enrichFiles } from "../src/slack/message-api-parsing.ts";
import { fetchThread, type SlackFileSummary } from "../src/slack/messages.ts";
import { searchMessagesViaSearchApi } from "../src/slack/search-messages.ts";

const originalFetch = globalThis.fetch;
const originalMaxWait = process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMaxWait === undefined) {
    delete process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS;
  } else {
    process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS = originalMaxWait;
  }
});

function snippets(): SlackFileSummary[] {
  return ["F11111111", "F22222222", "F33333333"].map((id) => ({ id, mode: "snippet" }));
}

describe("attachment metadata rate limits", () => {
  test("browser 429 stops remaining enrichment and preserves the reported retry-after diagnostic", async () => {
    process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS = "0";
    let calls = 0;
    const fetchMock = mock(async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ ok: true, file: { content: "first snippet evidence" } }))
        : new Response("", { status: 429, headers: { "Retry-After": "95" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SlackApiClient(
      { auth_type: "browser", xoxc_token: "xoxc-test", xoxd_cookie: "xoxd-test" },
      { workspaceUrl: "https://workspace.slack.com" },
    );

    await expect(enrichFiles(client, snippets())).rejects.toThrow(
      "Slack API call files.info was rate limited; retry-after 95s exceeds AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS=0.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("standard SDK rate-limit errors are rethrown unchanged before the next attachment", async () => {
    const failure = Object.assign(
      new Error("A rate-limit has been reached, you may retry this request in 120 seconds"),
      {
        code: ErrorCode.RateLimitedError,
        retryAfter: 120,
      },
    );
    const api = mock(async () => {
      throw failure;
    });
    const client = { api } as unknown as SlackApiClient;

    await expect(enrichFiles(client, snippets())).rejects.toBe(failure);
    expect(api).toHaveBeenCalledTimes(1);
  });

  test("Slack JSON rate-limit responses and final HTTP 429 failures stop enrichment", async () => {
    for (const failure of [
      new Error("ratelimited"),
      new Error("rate_limited"),
      new Error("Slack HTTP 429 calling files.info"),
      Object.assign(new Error("HTTP 429"), { code: ErrorCode.HTTPError, statusCode: 429 }),
      ...["ratelimited", "rate_limited"].map((error) =>
        Object.assign(new Error(`An API error occurred: ${error}`), {
          code: ErrorCode.PlatformError,
          data: { ok: false, error },
        }),
      ),
    ]) {
      const api = mock(async () => {
        throw failure;
      });
      await expect(enrichFiles({ api } as unknown as SlackApiClient, snippets())).rejects.toBe(
        failure,
      );
      expect(api).toHaveBeenCalledTimes(1);
    }
  });

  test("ordinary inaccessible files retain summary fallback and later complete snippet evidence", async () => {
    const files = snippets().slice(0, 2);
    const api = mock(async (_method: string, params: Record<string, unknown>) => {
      if (params.file === files[0]!.id) {
        throw new Error("file_not_found");
      }
      return {
        ok: true,
        file: {
          content: "full second snippet",
          filetype: "python",
          name: "second.py",
          url_private_download: "https://files.slack.com/second",
        },
      };
    });

    const result = await enrichFiles({ api } as unknown as SlackApiClient, files);
    expect(api).toHaveBeenCalledTimes(2);
    expect(result[0]).toEqual(files[0]);
    expect(result[1]?.snippet).toEqual({ content: "full second snippet", language: "python" });
    expect(result[1]?.name).toBe("second.py");
    expect(result[1]?.url_private_download).toBe("https://files.slack.com/second");
  });

  test("complete thread reads reject attachment 429 before further files or pages", async () => {
    const failure = Object.assign(
      new Error("A rate-limit has been reached, you may retry this request in 95 seconds"),
      {
        code: ErrorCode.RateLimitedError,
        retryAfter: 95,
      },
    );
    const calls: string[] = [];
    const api = mock(async (method: string) => {
      calls.push(method);
      if (method === "conversations.replies") {
        return {
          ok: true,
          messages: [
            {
              ts: "1700000000.000001",
              text: "please review",
              user: "U12345678",
              reply_count: 1,
              files: snippets(),
            },
          ],
          has_more: true,
          response_metadata: { next_cursor: "next-page" },
        };
      }
      throw failure;
    });

    await expect(
      fetchThread({ api } as unknown as SlackApiClient, {
        channelId: "C12345678",
        threadTs: "1700000000.000001",
        requireComplete: true,
      }),
    ).rejects.toBe(failure);
    expect(calls).toEqual(["conversations.replies", "files.info"]);
  });

  test("classification ignores non-rate-limit diagnostics", () => {
    for (const error of [
      new Error("file_not_found"),
      new Error("rate limit mentioned in file title"),
      Object.assign(new Error("HTTP 503"), { code: ErrorCode.HTTPError, statusCode: 503 }),
      Object.assign(new Error("An API error occurred: file_not_found"), {
        code: ErrorCode.PlatformError,
        data: { ok: false, error: "file_not_found" },
      }),
      null,
      "ratelimited",
    ]) {
      expect(isSlackRateLimitedError(error)).toBe(false);
    }
  });

  test("search stops at first attachment rate limit without partial success or fetching another match", async () => {
    for (const error of ["ratelimited", "rate_limited"]) {
      for (const requireCompleteResults of [false, true]) {
        const failure = Object.assign(new Error(`An API error occurred: ${error}`), {
          code: ErrorCode.PlatformError,
          data: { ok: false, error },
        });
        const calls: string[] = [];
        const api = mock(async (method: string, params: Record<string, unknown>) => {
          calls.push(method);
          if (method === "conversations.history") {
            return {
              ok: true,
              messages: [{ ts: params.latest, text: "review this", files: snippets() }],
            };
          }
          throw failure;
        });
        await expect(
          searchMessagesViaSearchApi({ api } as unknown as SlackApiClient, {
            auth: { auth_type: "standard", token: "xoxb-test" },
            workspace_url: "https://workspace.slack.com",
            slack_query: "review",
            limit: 2,
            maxContentChars: -1,
            contentType: "any",
            download: false,
            requireCompleteResults,
            rawMatches: ["1700000000.000001", "1700000001.000001"].map((ts) => ({
              ts,
              channel: { id: "C12345678" },
              permalink: `https://workspace.slack.com/archives/C12345678/p${ts.replace(".", "")}`,
            })),
          }),
        ).rejects.toBe(failure);
        expect(calls).toEqual(["conversations.history", "files.info"]);
      }
    }
  });

  test("search preserves rate-limit errors from a missing-message thread fallback", async () => {
    const failure = Object.assign(new Error("An HTTP protocol error occurred: statusCode = 429"), {
      code: ErrorCode.HTTPError,
      statusCode: 429,
    });
    const calls: string[] = [];
    const api = mock(async (method: string) => {
      calls.push(method);
      if (method === "conversations.history") {
        return { ok: true, messages: [] };
      }
      throw failure;
    });
    await expect(
      searchMessagesViaSearchApi({ api } as unknown as SlackApiClient, {
        auth: { auth_type: "standard", token: "xoxb-test" },
        workspace_url: "https://workspace.slack.com",
        slack_query: "review",
        limit: 2,
        maxContentChars: -1,
        contentType: "any",
        download: false,
        rawMatches: ["1700000000.000001", "1700000001.000001"].map((ts) => ({
          ts,
          channel: { id: "C12345678" },
        })),
      }),
    ).rejects.toBe(failure);
    expect(calls).toEqual(["conversations.history", "conversations.replies"]);
  });

  test("search stops immediately when fallback channel-name resolution is rate limited", async () => {
    const failure = Object.assign(new Error("An API error occurred: ratelimited"), {
      code: ErrorCode.PlatformError,
      data: { ok: false, error: "ratelimited" },
    });
    const api = mock(async () => {
      throw failure;
    });
    await expect(
      searchMessagesViaSearchApi({ api } as unknown as SlackApiClient, {
        auth: { auth_type: "standard", token: "xoxb-test" },
        workspace_url: "https://workspace.slack.com",
        slack_query: "review",
        limit: 2,
        maxContentChars: -1,
        contentType: "any",
        download: false,
        rawMatches: ["1700000000.000001", "1700000001.000001"].map((ts) => ({
          ts,
          channel: { name: "reviews" },
        })),
      }),
    ).rejects.toBe(failure);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
