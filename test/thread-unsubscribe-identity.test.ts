import { describe, expect, test } from "bun:test";
import type { CliContext } from "../src/cli/context.ts";
import { unsubscribeThreadTarget } from "../src/cli/thread-command.ts";
import type { SlackApiClient } from "../src/slack/client.ts";

const workspaceUrl = "https://workspace.slack.com";
const expectedUserId = "U12345678";

describe("thread unsubscribe identity across auth refresh", () => {
  test("refuses an unexpected actor before subscription access", async () => {
    const methods: string[] = [];
    const ctx = {
      withAutoRefresh: async <T>(request: { work: () => Promise<T> }) => await request.work(),
      getClientForWorkspace: async () => ({
        client: {
          api: async (method: string) => {
            methods.push(method);
            return { ok: true, team_id: "T12345678", user_id: "U99999999" };
          },
        } as unknown as SlackApiClient,
        auth: {
          auth_type: "browser" as const,
          xoxc_token: "xoxc-test",
          xoxd_cookie: "xoxd-test",
        },
        workspace_url: workspaceUrl,
      }),
    } as unknown as CliContext;

    await expect(
      unsubscribeThreadTarget({
        ctx,
        targetInput: `${workspaceUrl}/archives/C12345678/p1700000000000001`,
        expectedUserId,
      }),
    ).rejects.toThrow("does not match --expected-user-id");
    expect(methods).toEqual(["auth.test"]);
    expect(methods.some((method) => method.startsWith("subscriptions."))).toBe(false);
  });

  test("requires the auth.test user ID to match byte-for-byte", async () => {
    const methods: string[] = [];
    const ctx = {
      withAutoRefresh: async <T>(request: { work: () => Promise<T> }) => await request.work(),
      getClientForWorkspace: async () => ({
        client: {
          api: async (method: string) => {
            methods.push(method);
            return { ok: true, team_id: "T12345678", user_id: ` ${expectedUserId} ` };
          },
        } as unknown as SlackApiClient,
        auth: {
          auth_type: "browser" as const,
          xoxc_token: "xoxc-test",
          xoxd_cookie: "xoxd-test",
        },
        workspace_url: workspaceUrl,
      }),
    } as unknown as CliContext;

    await expect(
      unsubscribeThreadTarget({
        ctx,
        targetInput: `${workspaceUrl}/archives/C12345678/p1700000000000001`,
        expectedUserId,
      }),
    ).rejects.toThrow("does not match --expected-user-id");
    expect(methods).toEqual(["auth.test"]);
  });

  test("refuses a different same-workspace user after invalid_auth refresh", async () => {
    const calls: { attempt: number; method: string }[] = [];
    let attempt = 0;
    let refreshed = false;

    const ctx = {
      withAutoRefresh: async <T>(request: { work: () => Promise<T> }) => {
        try {
          return await request.work();
        } catch (err: unknown) {
          if (!(err instanceof Error) || err.message !== "invalid_auth") {
            throw err;
          }
          refreshed = true;
          return await request.work();
        }
      },
      getClientForWorkspace: async () => {
        attempt += 1;
        const currentAttempt = attempt;
        return {
          client: {
            api: async (method: string) => {
              calls.push({ attempt: currentAttempt, method });
              if (method !== "auth.test") {
                throw new Error(`Unexpected method before identity verification: ${method}`);
              }
              if (currentAttempt === 1) {
                throw new Error("invalid_auth");
              }
              return { ok: true, team_id: "T12345678", user_id: "U99999999" };
            },
          },
          auth: {
            auth_type: "browser" as const,
            xoxc_token: "xoxc-refreshed",
            xoxd_cookie: "xoxd-refreshed",
          },
          workspace_url: workspaceUrl,
        };
      },
    } as unknown as CliContext;

    await expect(
      unsubscribeThreadTarget({
        ctx,
        targetInput: `${workspaceUrl}/archives/C12345678/p1700000000000001`,
        expectedUserId,
      }),
    ).rejects.toThrow("does not match --expected-user-id");
    expect(refreshed).toBe(true);
    expect(calls).toEqual([
      { attempt: 1, method: "auth.test" },
      { attempt: 2, method: "auth.test" },
    ]);
    expect(calls.some((call) => call.method.startsWith("subscriptions."))).toBe(false);
  });
});
