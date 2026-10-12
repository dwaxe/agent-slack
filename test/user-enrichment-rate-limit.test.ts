import { describe, expect, mock, test } from "bun:test";
import { ErrorCode } from "@slack/web-api";
import type { SlackApiClient } from "../src/slack/client.ts";
import { resolveUsersById } from "../src/slack/user-cache.ts";
import { resolveUserId } from "../src/slack/users.ts";
import { resolveChannelId, resolveChannelName } from "../src/slack/channels.ts";

function rateFailure(error = "ratelimited") {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: ErrorCode.PlatformError,
    data: { ok: false, error },
  });
}

describe("optional profile enrichment rate limits", () => {
  test("profile 429 stops before the next batch and preserves the exact error", async () => {
    for (const error of ["ratelimited", "rate_limited"]) {
      const failure = rateFailure(error);
      const ids = Array.from(
        { length: 10 },
        (_, index) => `U${String(index + 1).padStart(8, "0")}`,
      );
      const calls: string[] = [];
      const api = mock(async (_method: string, params: Record<string, unknown>) => {
        const id = String(params.user);
        calls.push(id);
        if (id === ids[0]) {
          throw failure;
        }
        return { ok: true, user: { id, name: "reviewer" } };
      });
      await expect(
        resolveUsersById({
          client: { api, cacheScopeKey: () => "test-only" } as unknown as SlackApiClient,
          workspaceUrl: "",
          userIds: ids,
          forceRefresh: true,
        }),
      ).rejects.toBe(failure);
      expect(calls).toEqual(ids.slice(0, 5));
    }
  });

  test("ordinary optional profile failures still permit later batches", async () => {
    const ids = Array.from({ length: 6 }, (_, index) => `U${String(index + 1).padStart(8, "0")}`);
    const api = mock(async (_method: string, params: Record<string, unknown>) => {
      const id = String(params.user);
      if (id === ids[0]) {
        throw new Error("user_not_found");
      }
      return { ok: true, user: { id, name: "reviewer" } };
    });
    const result = await resolveUsersById({
      client: { api, cacheScopeKey: () => "test-only" } as unknown as SlackApiClient,
      workspaceUrl: "",
      userIds: ids,
      forceRefresh: true,
    });
    expect(api).toHaveBeenCalledTimes(6);
    expect(result.size).toBe(5);
    expect(result.has(ids[5]!)).toBe(true);
  });

  test("channel-name lookup does not replace a search 429 with a directory scan", async () => {
    const failure = rateFailure();
    const api = mock(async () => {
      throw failure;
    });
    await expect(resolveChannelId({ api } as unknown as SlackApiClient, "#reviews")).rejects.toBe(
      failure,
    );
    expect(api).toHaveBeenCalledTimes(1);
  });

  test("DM profile 429 survives both optional channel-name catches", async () => {
    const failure = rateFailure();
    const calls: string[] = [];
    const api = mock(async (method: string) => {
      calls.push(method);
      if (method === "conversations.info") {
        return { ok: true, channel: { is_im: true, user: "U12345678" } };
      }
      throw failure;
    });
    await expect(
      resolveChannelName({ api } as unknown as SlackApiClient, "D12345678"),
    ).rejects.toBe(failure);
    expect(calls).toEqual(["conversations.info", "users.info"]);
  });

  test("DM name enrichment keeps a raw-ID fallback for non-rate failures", async () => {
    const api = mock(async (method: string) => {
      if (method === "conversations.info") {
        return { ok: true, channel: { is_im: true, user: "U12345678" } };
      }
      throw new Error("user_not_found");
    });
    expect(await resolveChannelName({ api } as unknown as SlackApiClient, "D12345678")).toBe(
      "D12345678",
    );
  });

  test("email lookup does not replace a 429 with users.list pagination", async () => {
    const failure = rateFailure();
    const api = mock(async () => {
      throw failure;
    });
    await expect(
      resolveUserId({ api } as unknown as SlackApiClient, "reviewer@example.com"),
    ).rejects.toBe(failure);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
