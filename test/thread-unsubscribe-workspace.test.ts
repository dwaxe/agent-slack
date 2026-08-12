import { describe, expect, test } from "bun:test";
import type { CliContext } from "../src/cli/context.ts";
import { unsubscribeThreadTarget } from "../src/cli/thread-command.ts";
import type { SlackApiClient } from "../src/slack/client.ts";

const workspaceUrl = "https://workspace.slack.com";
const expectedUserId = "U12345678";
const workspaceTeamId = "T12345678";
const targetInput = `${workspaceUrl}/archives/C12345678/p1700000000000001`;

function createContext(input?: {
  authUrl?: string;
  authTeamId?: string | null;
  teamInfoTeamId?: string;
}): { ctx: CliContext; methods: string[] } {
  const methods: string[] = [];
  const client = {
    api: async (method: string) => {
      methods.push(method);
      if (method === "auth.test") {
        return {
          ok: true,
          user_id: expectedUserId,
          url: input?.authUrl ?? workspaceUrl,
          ...(input?.authTeamId === null ? {} : { team_id: input?.authTeamId ?? workspaceTeamId }),
        };
      }
      if (method === "team.info") {
        return {
          ok: true,
          team: { id: input?.teamInfoTeamId ?? workspaceTeamId },
        };
      }
      throw new Error(`Unexpected Slack API method: ${method}`);
    },
  } as unknown as SlackApiClient;
  const ctx = {
    withAutoRefresh: async <T>(request: { work: () => Promise<T> }) => await request.work(),
    getClientForWorkspace: async () => ({
      client,
      auth: {
        auth_type: "browser" as const,
        xoxc_token: "xoxc-test",
        xoxd_cookie: "xoxd-test",
      },
      workspace_url: workspaceUrl,
    }),
  } as unknown as CliContext;
  return { ctx, methods };
}

function expectNoSubscriptionAccess(methods: string[]): void {
  expect(methods.some((method) => method.startsWith("subscriptions."))).toBe(false);
}

describe("thread unsubscribe workspace binding", () => {
  test("rejects an auth.test URL from a different workspace origin", async () => {
    const { ctx, methods } = createContext({ authUrl: "https://other.slack.com/" });

    await expect(unsubscribeThreadTarget({ ctx, targetInput, expectedUserId })).rejects.toThrow(
      "workspace origin does not match the target URL",
    );
    expect(methods).toEqual(["auth.test"]);
    expectNoSubscriptionAccess(methods);
  });

  test("rejects missing and malformed auth.test workspace team IDs", async () => {
    for (const authTeamId of [
      null,
      "",
      "T1234",
      "E12345678",
      " T12345678",
      "T12345678901234567890",
    ]) {
      const { ctx, methods } = createContext({ authTeamId });

      await expect(unsubscribeThreadTarget({ ctx, targetInput, expectedUserId })).rejects.toThrow(
        "did not return a canonical workspace team ID",
      );
      expect(methods).toEqual(["auth.test"]);
      expectNoSubscriptionAccess(methods);
    }
  });

  test("rejects a team.info workspace mismatch before subscription access", async () => {
    const { ctx, methods } = createContext({ teamInfoTeamId: "T99999999" });

    await expect(unsubscribeThreadTarget({ ctx, targetInput, expectedUserId })).rejects.toThrow(
      "team.info does not match the workspace verified by auth.test",
    );
    expect(methods).toEqual(["auth.test", "team.info"]);
    expectNoSubscriptionAccess(methods);
  });
});
