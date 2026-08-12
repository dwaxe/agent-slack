import type { SlackAuth, SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

type ThreadSubscriptionClient = Pick<SlackApiClient, "api">;

export type ThreadUnsubscribeResult = {
  ok: true;
  status: "unsubscribed" | "already_unsubscribed";
  channel_id: string;
  thread_ts: string;
  subscribed: false;
};

async function readThreadSubscription(
  client: ThreadSubscriptionClient,
  input: { channelId: string; threadTs: string; teamId?: string },
): Promise<boolean> {
  const response = await client.api("subscriptions.thread.get", {
    channel: input.channelId,
    thread_ts: input.threadTs,
    team_id: input.teamId,
  });
  if (!Array.isArray(response.subscriptions)) {
    throw new Error(
      "Slack did not return an unambiguous thread subscription state; refusing to change it.",
    );
  }
  if (response.subscriptions.some((subscription) => typeof subscription !== "string")) {
    throw new Error("Slack returned a malformed thread subscription state; refusing to change it.");
  }
  if (response.subscriptions.length === 0) {
    return false;
  }
  if (response.subscriptions.length === 1 && response.subscriptions[0] === input.threadTs) {
    return true;
  }
  throw new Error("Slack returned an unexpected thread subscription state; refusing to change it.");
}

async function readThreadLastRead(
  client: ThreadSubscriptionClient,
  input: { channelId: string; threadTs: string },
): Promise<string> {
  const response = await client.api("conversations.replies", {
    channel: input.channelId,
    ts: input.threadTs,
    limit: 1,
  });
  const root = asArray(response.messages).find(
    (message): message is Record<string, unknown> =>
      isRecord(message) && getString(message.ts) === input.threadTs,
  );
  if (!root) {
    throw new Error("Thread root was not returned by Slack; refusing to change its subscription.");
  }

  const lastRead = getString(root.last_read)?.trim() || undefined;
  if (!lastRead) {
    throw new Error(
      "Slack did not return the thread's current last_read value; refusing to unsubscribe.",
    );
  }
  return lastRead;
}

/**
 * Unfollow one exact Slack thread and verify the resulting state.
 *
 * Slack does not expose a public unfollow method. Keep the unsupported
 * browser-session endpoint isolated here so callers cannot supply credentials,
 * raw API methods, or arbitrary request fields.
 */
export async function unsubscribeThread(input: {
  client: ThreadSubscriptionClient;
  subscriptionClient?: ThreadSubscriptionClient;
  auth: SlackAuth;
  channelId: string;
  threadTs: string;
  teamId?: string;
}): Promise<ThreadUnsubscribeResult> {
  if (input.auth.auth_type !== "browser") {
    throw new Error("Thread unsubscribe requires browser auth (xoxc token and xoxd cookie).");
  }

  const subscriptionClient = input.subscriptionClient ?? input.client;
  const subscribedBefore = await readThreadSubscription(subscriptionClient, {
    channelId: input.channelId,
    threadTs: input.threadTs,
    teamId: input.teamId,
  });
  if (!subscribedBefore) {
    return {
      ok: true,
      status: "already_unsubscribed",
      channel_id: input.channelId,
      thread_ts: input.threadTs,
      subscribed: false,
    };
  }
  const lastRead = await readThreadLastRead(input.client, {
    channelId: input.channelId,
    threadTs: input.threadTs,
  });

  await subscriptionClient.api("subscriptions.thread.remove", {
    channel: input.channelId,
    thread_ts: input.threadTs,
    last_read: lastRead,
    team_id: input.teamId,
  });

  const subscribedAfter = await readThreadSubscription(subscriptionClient, {
    channelId: input.channelId,
    threadTs: input.threadTs,
    teamId: input.teamId,
  });
  if (subscribedAfter) {
    throw new Error("Slack still reports the thread as subscribed after the unsubscribe request.");
  }

  return {
    ok: true,
    status: "unsubscribed",
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    subscribed: false,
  };
}
