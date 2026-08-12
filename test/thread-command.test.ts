import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { registerThreadCommand, unsubscribeThreadTarget } from "../src/cli/thread-command.ts";

type ApiCall = {
  client: "workspace" | "enterprise";
  method: string;
  params: Record<string, unknown>;
};

const workspaceUrl = "https://workspace.slack.com";
const enterpriseUrl = "https://grid.enterprise.slack.com";
const threadTs = "1700000000.000001";

function createContext(input?: {
  authType?: "browser" | "standard";
  enterprise?: boolean;
  mismatchedEnterprise?: boolean;
  mismatchedEnterpriseUser?: boolean;
}) {
  const calls: ApiCall[] = [];
  const workspaceCalls: (string | undefined)[] = [];
  let subscribed = true;
  const api =
    (kind: "workspace" | "enterprise") =>
    async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ client: kind, method, params });
      if (method === "team.info") {
        return input?.enterprise
          ? {
              ok: true,
              team: {
                id: "T12345678",
                enterprise_id: "E12345678",
                enterprise_domain: "grid",
              },
            }
          : { ok: true, team: { id: "T12345678" } };
      }
      if (method === "auth.test") {
        return kind === "workspace"
          ? { ok: true, team_id: "T12345678", user_id: "U12345678" }
          : {
              ok: true,
              team_id: input?.mismatchedEnterprise ? "E99999999" : "E12345678",
              user_id: input?.mismatchedEnterpriseUser ? "U99999999" : "U12345678",
            };
      }
      if (method === "subscriptions.thread.get") {
        return { ok: true, subscriptions: subscribed ? [threadTs] : [] };
      }
      if (method === "subscriptions.thread.remove") {
        subscribed = false;
        return { ok: true };
      }
      if (method === "conversations.replies") {
        return {
          ok: true,
          messages: [{ ts: params.ts, last_read: "1700000001.000002" }],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    };
  const workspaceClient = { api: api("workspace") };
  const enterpriseClient = { api: api("enterprise") };
  const auth =
    input?.authType === "standard"
      ? ({ auth_type: "standard", token: "xoxb-test" } as const)
      : ({
          auth_type: "browser",
          xoxc_token: "xoxc-test",
          xoxd_cookie: "xoxd-test",
        } as const);

  const ctx: CliContext = {
    effectiveWorkspaceUrl: (flag?: string) => flag,
    assertWorkspaceSpecifiedForChannelNames: async () => {},
    withAutoRefresh: async <T>(request: {
      workspaceUrl: string | undefined;
      work: () => Promise<T>;
    }) => request.work(),
    getClientForWorkspace: async (selector?: string) => {
      workspaceCalls.push(selector);
      if (selector === enterpriseUrl) {
        return {
          client: enterpriseClient as never,
          auth,
          workspace_url: enterpriseUrl,
        };
      }
      return {
        client: workspaceClient as never,
        auth,
        workspace_url: workspaceUrl,
      };
    },
    normalizeUrl: (url: string) => url,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    parseContentType: () => "any",
    parseCurl: (_curl: string) => ({
      workspace_url: workspaceUrl,
      xoxc_token: "xoxc-test",
      xoxd_cookie: "xoxd-test",
    }),
    importDesktop: async () => ({
      cookie_d: "",
      teams: [],
      source: { leveldb_path: "", cookies_path: "" },
    }),
    importChrome: () => ({ cookie_d: "", teams: [] }),
    importBrave: async () => null,
    importFirefox: async () => null,
  };

  return { ctx, calls, workspaceCalls };
}

describe("unsubscribeThreadTarget", () => {
  test("uses a root message URL as the exact thread target", async () => {
    const { ctx, calls, workspaceCalls } = createContext();

    await expect(
      unsubscribeThreadTarget({
        ctx,
        targetInput: `${workspaceUrl}/archives/C12345678/p1700000000000001`,
      }),
    ).resolves.toEqual({
      ok: true,
      status: "unsubscribed",
      channel_id: "C12345678",
      thread_ts: threadTs,
      subscribed: false,
      workspace_url: workspaceUrl,
      permalink: `${workspaceUrl}/archives/C12345678/p1700000000000001`,
    });
    expect(workspaceCalls).toEqual([workspaceUrl]);
    expect(calls.map((call) => call.method)).toEqual([
      "team.info",
      "subscriptions.thread.get",
      "conversations.replies",
      "subscriptions.thread.remove",
      "subscriptions.thread.get",
    ]);
  });

  test("uses thread_ts from a reply permalink", async () => {
    const { ctx, calls } = createContext();

    const result = await unsubscribeThreadTarget({
      ctx,
      targetInput: `${workspaceUrl}/archives/C12345678/p1700000009000009?thread_ts=${threadTs}&cid=C12345678`,
    });

    expect(result.thread_ts).toBe(threadTs);
    const rootRead = calls.find((call) => call.method === "conversations.replies");
    expect(rootRead?.params.ts).toBe(threadTs);
  });

  test("routes Enterprise Grid subscription calls through the organization", async () => {
    const { ctx, calls, workspaceCalls } = createContext({ enterprise: true });

    await unsubscribeThreadTarget({
      ctx,
      targetInput: `${workspaceUrl}/archives/C12345678/p1700000000000001`,
    });

    expect(workspaceCalls).toEqual([workspaceUrl, enterpriseUrl]);
    expect(calls.find((call) => call.method === "conversations.replies")?.client).toBe("workspace");
    for (const call of calls.filter((candidate) => candidate.method.startsWith("subscriptions."))) {
      expect(call.client).toBe("enterprise");
      expect(call.params.team_id).toBe("T12345678");
    }
  });

  test("rejects mismatched Enterprise Grid credentials before subscription access", async () => {
    const { ctx, calls } = createContext({ enterprise: true, mismatchedEnterprise: true });

    await expect(
      unsubscribeThreadTarget({
        ctx,
        targetInput: `${workspaceUrl}/archives/C12345678/p1700000000000001`,
      }),
    ).rejects.toThrow("do not match the target workspace's organization");
    expect(calls.some((call) => call.method.startsWith("subscriptions."))).toBe(false);
  });

  test("rejects Enterprise Grid credentials for a different Slack user", async () => {
    const { ctx, calls } = createContext({
      enterprise: true,
      mismatchedEnterpriseUser: true,
    });

    await expect(
      unsubscribeThreadTarget({
        ctx,
        targetInput: `${workspaceUrl}/archives/C12345678/p1700000000000001`,
      }),
    ).rejects.toThrow("do not belong to the same Slack user");
    expect(calls.some((call) => call.method.startsWith("subscriptions."))).toBe(false);
  });

  test("rejects non-https URLs before resolving credentials", async () => {
    const { ctx, calls, workspaceCalls } = createContext();

    await expect(
      unsubscribeThreadTarget({
        ctx,
        targetInput: "http://workspace.slack.com/archives/C12345678/p1700000000000001",
      }),
    ).rejects.toThrow("requires an https Slack message URL");
    expect(workspaceCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("rejects non-URL targets before resolving credentials", async () => {
    const { ctx, calls, workspaceCalls } = createContext();

    await expect(unsubscribeThreadTarget({ ctx, targetInput: "#general" })).rejects.toThrow(
      "Invalid URL",
    );
    expect(workspaceCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("rejects standard auth before making a Slack request", async () => {
    const { ctx, calls } = createContext({ authType: "standard" });

    await expect(
      unsubscribeThreadTarget({
        ctx,
        targetInput: `${workspaceUrl}/archives/C12345678/p1700000000000001`,
      }),
    ).rejects.toThrow("requires browser auth");
    expect(calls).toHaveLength(0);
  });
});

describe("thread unsubscribe command", () => {
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = 0;
    console.log = originalLog;
    console.error = originalError;
  });

  test("prints verified JSON on success", async () => {
    const { ctx } = createContext();
    const program = new Command();
    registerThreadCommand({ program, ctx });
    const log = mock((_message: string) => {});
    console.log = log as typeof console.log;

    await program.parseAsync(
      ["thread", "unsubscribe", `${workspaceUrl}/archives/C12345678/p1700000000000001`],
      { from: "user" },
    );

    expect(process.exitCode).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      ok: true,
      status: "unsubscribed",
      subscribed: false,
    });
  });

  test("prints an error and exits nonzero on invalid input", async () => {
    const { ctx } = createContext();
    const program = new Command();
    registerThreadCommand({ program, ctx });
    const error = mock((_message: string) => {});
    console.error = error as typeof console.error;

    await program.parseAsync(["thread", "unsubscribe", "#general"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("Invalid URL");
  });
});
