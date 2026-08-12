import { describe, expect, test } from "bun:test";
import type { SlackAuth, SlackApiClient } from "../src/slack/client.ts";
import { unsubscribeThread } from "../src/slack/thread-subscriptions.ts";

type ApiCall = { method: string; params: Record<string, unknown> };

const channelId = "C12345678";
const threadTs = "1700000000.000001";
const lastRead = "1700000001.000002";
const browserAuth: SlackAuth = {
  auth_type: "browser",
  xoxc_token: "xoxc-test",
  xoxd_cookie: "xoxd-test",
};

function createClient(
  handler: (call: ApiCall, index: number) => Promise<Record<string, unknown>>,
): { client: SlackApiClient; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const client = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      const call = { method, params };
      calls.push(call);
      return handler(call, calls.length - 1);
    },
  } as SlackApiClient;
  return { client, calls };
}

function threadRoot(input?: { lastRead?: string; ts?: string }): Record<string, unknown> {
  return {
    ts: input?.ts ?? threadTs,
    last_read: input?.lastRead ?? lastRead,
  };
}

describe("unsubscribeThread", () => {
  test("rejects standard auth before making a Slack request", async () => {
    const { client, calls } = createClient(async () => ({ ok: true }));

    await expect(
      unsubscribeThread({
        client,
        auth: { auth_type: "standard", token: "xoxb-test" },
        channelId,
        threadTs,
      }),
    ).rejects.toThrow("requires browser auth");
    expect(calls).toHaveLength(0);
  });

  test("returns idempotent success when the thread is already unsubscribed", async () => {
    const { client, calls } = createClient(async () => ({ ok: true, subscriptions: [] }));

    await expect(
      unsubscribeThread({ client, auth: browserAuth, channelId, threadTs }),
    ).resolves.toEqual({
      ok: true,
      status: "already_unsubscribed",
      channel_id: channelId,
      thread_ts: threadTs,
      subscribed: false,
    });
    expect(calls).toEqual([
      {
        method: "subscriptions.thread.get",
        params: { channel: channelId, thread_ts: threadTs, team_id: undefined },
      },
    ]);
  });

  test("preserves last_read, removes through the subscription client, and verifies", async () => {
    const root = createClient(async () => ({ ok: true, messages: [threadRoot()] }));
    let subscribed = true;
    const subscription = createClient(async (call) => {
      if (call.method === "subscriptions.thread.remove") {
        subscribed = false;
        return { ok: true };
      }
      return { ok: true, subscriptions: subscribed ? [threadTs] : [] };
    });

    await expect(
      unsubscribeThread({
        client: root.client,
        subscriptionClient: subscription.client,
        auth: browserAuth,
        channelId,
        threadTs,
        teamId: "T12345678",
      }),
    ).resolves.toEqual({
      ok: true,
      status: "unsubscribed",
      channel_id: channelId,
      thread_ts: threadTs,
      subscribed: false,
    });
    expect(root.calls).toEqual([
      {
        method: "conversations.replies",
        params: { channel: channelId, ts: threadTs, limit: 1 },
      },
    ]);
    expect(subscription.calls).toEqual([
      {
        method: "subscriptions.thread.get",
        params: { channel: channelId, thread_ts: threadTs, team_id: "T12345678" },
      },
      {
        method: "subscriptions.thread.remove",
        params: {
          channel: channelId,
          thread_ts: threadTs,
          last_read: lastRead,
          team_id: "T12345678",
        },
      },
      {
        method: "subscriptions.thread.get",
        params: { channel: channelId, thread_ts: threadTs, team_id: "T12345678" },
      },
    ]);
  });

  test("fails closed when a subscribed thread has no last_read value", async () => {
    const { client, calls } = createClient(async (call) =>
      call.method === "subscriptions.thread.get"
        ? { ok: true, subscriptions: [threadTs] }
        : { ok: true, messages: [{ ts: threadTs }] },
    );

    await expect(
      unsubscribeThread({ client, auth: browserAuth, channelId, threadTs }),
    ).rejects.toThrow("current last_read");
    expect(calls.map((call) => call.method)).toEqual([
      "subscriptions.thread.get",
      "conversations.replies",
    ]);
  });

  test("fails closed when Slack omits the subscription list", async () => {
    const { client, calls } = createClient(async () => ({ ok: true }));

    await expect(
      unsubscribeThread({ client, auth: browserAuth, channelId, threadTs }),
    ).rejects.toThrow("unambiguous thread subscription state");
    expect(calls).toHaveLength(1);
  });

  test("fails closed on malformed or unexpected subscription entries", async () => {
    for (const subscriptions of [[123], ["1700000009.000009"]]) {
      const { client, calls } = createClient(async () => ({ ok: true, subscriptions }));

      await expect(
        unsubscribeThread({ client, auth: browserAuth, channelId, threadTs }),
      ).rejects.toThrow(/malformed|unexpected/);
      expect(calls).toHaveLength(1);
    }
  });

  test("fails closed when Slack does not return the exact thread root", async () => {
    const { client, calls } = createClient(async (call) =>
      call.method === "subscriptions.thread.get"
        ? { ok: true, subscriptions: [threadTs] }
        : { ok: true, messages: [threadRoot({ ts: "1700000009.000009" })] },
    );

    await expect(
      unsubscribeThread({ client, auth: browserAuth, channelId, threadTs }),
    ).rejects.toThrow("Thread root was not returned");
    expect(calls).toHaveLength(2);
  });

  test("fails when read-back still reports a subscription", async () => {
    const { client, calls } = createClient(async (call) => {
      if (call.method === "subscriptions.thread.remove") {
        return { ok: true };
      }
      if (call.method === "conversations.replies") {
        return { ok: true, messages: [threadRoot()] };
      }
      return { ok: true, subscriptions: [threadTs] };
    });

    await expect(
      unsubscribeThread({ client, auth: browserAuth, channelId, threadTs }),
    ).rejects.toThrow("still reports the thread as subscribed");
    expect(calls.map((call) => call.method)).toEqual([
      "subscriptions.thread.get",
      "conversations.replies",
      "subscriptions.thread.remove",
      "subscriptions.thread.get",
    ]);
  });

  test("propagates removal errors without retrying the mutation", async () => {
    const { client, calls } = createClient(async (call) => {
      if (call.method === "subscriptions.thread.remove") {
        throw new Error("not_allowed");
      }
      if (call.method === "conversations.replies") {
        return { ok: true, messages: [threadRoot()] };
      }
      return { ok: true, subscriptions: [threadTs] };
    });

    await expect(
      unsubscribeThread({ client, auth: browserAuth, channelId, threadTs }),
    ).rejects.toThrow("not_allowed");
    expect(calls.map((call) => call.method)).toEqual([
      "subscriptions.thread.get",
      "conversations.replies",
      "subscriptions.thread.remove",
    ]);
  });

  test("a retry after an inconclusive read-back does not repeat a successful removal", async () => {
    let subscribed = true;
    let failReadBack = true;
    const { client, calls } = createClient(async (call) => {
      if (call.method === "subscriptions.thread.remove") {
        subscribed = false;
        return { ok: true };
      }
      if (call.method === "conversations.replies") {
        return { ok: true, messages: [threadRoot()] };
      }
      if (!subscribed && failReadBack) {
        failReadBack = false;
        throw new Error("invalid_auth");
      }
      return { ok: true, subscriptions: subscribed ? [threadTs] : [] };
    });
    const request = { client, auth: browserAuth, channelId, threadTs };

    await expect(unsubscribeThread(request)).rejects.toThrow("invalid_auth");
    await expect(unsubscribeThread(request)).resolves.toMatchObject({
      status: "already_unsubscribed",
      subscribed: false,
    });
    expect(calls.filter((call) => call.method === "subscriptions.thread.remove")).toHaveLength(1);
  });
});
