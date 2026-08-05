import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReferencedUserIds,
  getCachedUserById,
  resolveUsersById,
  toReferencedUsers,
} from "../src/slack/user-cache.ts";
import type { SlackApiClient } from "../src/slack/client.ts";
import type { SlackMessageSummary } from "../src/slack/messages.ts";
import type { CompactSlackUser } from "../src/slack/users.ts";

describe("user-cache helpers", () => {
  test("collectReferencedUserIds excludes reaction users by default", () => {
    const messages: SlackMessageSummary[] = [
      {
        channel_id: "C1",
        ts: "1.000001",
        text: "hey <@U22222222>",
        markdown: "hey @U22222222",
        user: "U11111111",
        reactions: [{ name: "eyes", users: ["U11111111", "U33333333"] }],
      },
      {
        channel_id: "C1",
        ts: "1.000002",
        text: "follow-up for <@U33333333> and <@U22222222>",
        markdown: "follow-up",
        user: "U11111111",
      },
    ];

    expect(collectReferencedUserIds(messages).sort()).toEqual([
      "U11111111",
      "U22222222",
      "U33333333",
    ]);
  });

  test("collectReferencedUserIds includes reaction users when enabled", () => {
    const messages: SlackMessageSummary[] = [
      {
        channel_id: "C1",
        ts: "1.000001",
        text: "hey <@W22222222> and <@B22222222>",
        markdown: "hey @W22222222",
        user: "W11111111",
        reactions: [{ name: "eyes", users: ["W11111111", "W44444444"] }],
      },
    ];

    expect(collectReferencedUserIds(messages, { includeReactions: true }).sort()).toEqual([
      "W11111111",
      "W22222222",
      "W44444444",
    ]);
  });

  test("toReferencedUsers returns only resolved users keyed by id", () => {
    const usersById = new Map<string, CompactSlackUser>([
      ["U11111111", { id: "U11111111", name: "alice", display_name: "Alice" }],
      ["U22222222", { id: "U22222222", name: "bob", display_name: "Bob" }],
    ]);

    expect(toReferencedUsers(["U11111111", "U11111111", "U99999999"], usersById)).toEqual({
      U11111111: { id: "U11111111", name: "alice", display_name: "Alice" },
    });
    expect(toReferencedUsers(["U99999999"], usersById)).toBeUndefined();
  });
});

const USER_ID = "U11111111";
const WORKSPACE = "https://workspace.slack.com";

function mockClient(
  api: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  scope = "principal-a",
): SlackApiClient {
  return { api, cacheScopeKey: () => scope } as unknown as SlackApiClient;
}

function lookup(
  client: SlackApiClient,
  forceRefresh = false,
): Promise<CompactSlackUser | undefined> {
  return getCachedUserById({
    client,
    workspaceUrl: WORKSPACE,
    userId: USER_ID,
    forceRefresh,
  });
}

function userResponse(name: string): Record<string, unknown> {
  return {
    user: {
      id: USER_ID,
      name,
      real_name: "Alice Example",
      tz: "America/Los_Angeles",
      profile: {
        display_name: "Alice",
        email: "alice@example.com",
        title: "Engineer",
        status_text: "Heads down",
        status_emoji: ":computer:",
        status_expiration: 123,
      },
    },
  };
}

describe("user profile cache", () => {
  const originalXdg = process.env.XDG_RUNTIME_DIR;
  let runtimeDir = "";

  beforeEach(async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), "agent-slack-user-cache-test-"));
    process.env.XDG_RUNTIME_DIR = runtimeDir;
  });

  afterEach(async () => {
    if (originalXdg === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = originalXdg;
    }
    await rm(runtimeDir, { recursive: true, force: true });
  });

  test("reuses the complete profile and refreshes it on request", async () => {
    let calls = 0;
    const client = mockClient(async () => userResponse(`alice-${++calls}`));

    const first = await lookup(client);
    expect(await lookup(client)).toEqual(first);
    expect(first).toMatchObject({
      name: "alice-1",
      email: "alice@example.com",
      status_text: "Heads down",
    });
    expect(calls).toBe(1);

    const refreshed = await lookup(client, true);
    expect(refreshed).toMatchObject({ name: "alice-2" });
    expect(await lookup(client)).toEqual(refreshed);
    expect(calls).toBe(2);
  });

  test("isolates cache entries by workspace and credentials", async () => {
    const calls: string[] = [];
    const clientFor = (label: string, scope = "principal-a") =>
      mockClient(async () => {
        calls.push(label);
        return userResponse(label);
      }, scope);

    await lookup(clientFor("workspace-a"));
    await lookup(clientFor("cache-hit"));
    await getCachedUserById({
      client: clientFor("workspace-b"),
      workspaceUrl: "https://other.slack.com",
      userId: USER_ID,
    });
    await lookup(clientFor("principal-b", "principal-b"));
    await lookup(clientFor("principal-a-again"));

    expect(calls).toEqual(["workspace-a", "workspace-b", "principal-b", "principal-a-again"]);
  });

  test("rejects mismatched cached and live user IDs", async () => {
    await lookup(mockClient(async () => userResponse("old")));
    const cacheDir = join(runtimeDir, "agent-slack");
    const [cacheName] = (await readdir(cacheDir)).filter((name) => name.startsWith("users-cache-"));
    const cachePath = join(cacheDir, cacheName!);
    const cache = JSON.parse(await readFile(cachePath, "utf8")) as {
      entries: Record<string, { user: { id: string } }>;
    };
    cache.entries[USER_ID]!.user.id = "U22222222";
    await writeFile(cachePath, JSON.stringify(cache));

    expect(await lookup(mockClient(async () => userResponse("fresh")))).toMatchObject({
      name: "fresh",
    });
    expect(
      await lookup(
        mockClient(async () => ({ user: { id: "U22222222", name: "wrong" } })),
        true,
      ),
    ).toBeUndefined();

    let calls = 0;
    const preserved = await lookup(
      mockClient(async () => {
        calls += 1;
        return userResponse("unexpected");
      }),
    );
    expect(preserved).toMatchObject({ name: "fresh" });
    expect(calls).toBe(0);
  });

  test("treats cache I/O as best effort", async () => {
    const blockedPath = join(runtimeDir, "not-a-directory");
    await writeFile(blockedPath, "blocked");
    process.env.XDG_RUNTIME_DIR = blockedPath;

    expect(await lookup(mockClient(async () => userResponse("alice")))).toMatchObject({
      name: "alice",
    });
  });

  test("preserves singular and batch API error behavior", async () => {
    const slackError = new Error("invalid_auth");
    const client = mockClient(async () => {
      throw slackError;
    });

    await expect(lookup(client)).rejects.toBe(slackError);
    expect(await resolveUsersById({ client, workspaceUrl: WORKSPACE, userIds: [USER_ID] })).toEqual(
      new Map(),
    );
  });
});
