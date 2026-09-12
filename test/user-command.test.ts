import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { registerUserCommand } from "../src/cli/user-command.ts";

type ApiCall = { method: string; params: Record<string, unknown> };

function user(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const profile =
    fields.profile && typeof fields.profile === "object" && !Array.isArray(fields.profile)
      ? fields.profile
      : {};
  return {
    id,
    deleted: false,
    is_bot: false,
    ...fields,
    profile: { ...profile },
  };
}

function createContext(input: {
  api?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  withAutoRefresh?: CliContext["withAutoRefresh"];
  getClientForWorkspace?: CliContext["getClientForWorkspace"];
  canonicalWorkspace?: string | null;
}) {
  const client = {
    api:
      input.api ??
      (async () => {
        throw new Error("Unexpected Slack API call");
      }),
    lookupUserByEmail: (email: string) =>
      input.api
        ? input.api("users.lookupByEmail", { email })
        : Promise.reject(new Error("Unexpected Slack API call")),
  };
  const ctx: CliContext = {
    effectiveWorkspaceUrl: (flag?: string) => flag,
    assertWorkspaceSpecifiedForChannelNames: async () => {},
    withAutoRefresh:
      input.withAutoRefresh ??
      (async <T>(workInput: { workspaceUrl: string | undefined; work: () => Promise<T> }) =>
        workInput.work()),
    getClientForWorkspace:
      input.getClientForWorkspace ??
      (async () => ({
        client: client as never,
        auth: { auth_type: "standard", token: "x" },
        workspace_url:
          input.canonicalWorkspace === null
            ? undefined
            : (input.canonicalWorkspace ?? "https://workspace.slack.com"),
      })),
    normalizeUrl: (u: string) => new URL(u).origin,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    parseContentType: () => "any",
    parseCurl: () => ({
      workspace_url: "https://workspace.slack.com",
      xoxc_token: "xoxc-1",
      xoxd_cookie: "xoxd-1",
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
  return ctx;
}

async function runResolve(ctx: CliContext, ...args: string[]): Promise<void> {
  const program = new Command();
  registerUserCommand({ program, ctx });
  await program.parseAsync(["user", "resolve", ...args], { from: "user" });
}

describe("user resolve command", () => {
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

  test("proves the workspace and uses only direct lookups for a safe batch", async () => {
    const calls: ApiCall[] = [];
    const ctx = createContext({
      api: async (method, params) => {
        calls.push({ method, params });
        if (method === "auth.test") {
          return { url: "https://workspace.slack.com/", team_id: "T12345678" };
        }
        if (method === "users.info") {
          return { user: user(String(params.user)) };
        }
        if (method === "users.lookupByEmail") {
          return { user: user("U22222222") };
        }
        throw new Error(`Unexpected Slack method: ${method}`);
      },
    });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await runResolve(ctx, "U11111111", "person@example.com", "--workspace", "workspace");

    expect(calls).toEqual([
      { method: "auth.test", params: {} },
      { method: "users.info", params: { user: "U11111111" } },
      { method: "users.lookupByEmail", params: { email: "person@example.com" } },
    ]);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      workspace: "https://workspace.slack.com",
      lookups: { status: "complete", requests: 2 },
      safe_to_mention: true,
    });
    expect(JSON.stringify(payload)).toContain("<@U11111111>");
    expect(JSON.stringify(payload)).toContain("<@U22222222>");
    expect(process.exitCode).toBe(0);
  });

  test("suppresses every mention and exits nonzero for a mixed batch", async () => {
    const ctx = createContext({
      api: async (method, params) => {
        if (method === "auth.test") {
          return { url: "https://workspace.slack.com/", team_id: "T12345678" };
        }
        if (method === "users.info") {
          return { user: user(String(params.user)) };
        }
        throw new Error("users_not_found");
      },
    });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await runResolve(ctx, "U11111111", "missing@example.com");

    const output = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      lookups: { status: "complete", requests: 2 },
      safe_to_mention: false,
    });
    expect(output).not.toContain("<@");
    expect(process.exitCode).toBe(1);
  });

  test("turns a terminal lookup failure into structured incomplete JSON", async () => {
    const ctx = createContext({
      api: async (method) => {
        if (method === "auth.test") {
          return { url: "https://workspace.slack.com/", team_id: "T12345678" };
        }
        throw new Error("Slack API call users.lookupByEmail was rate limited");
      },
    });
    const log = mock((_value?: unknown) => {});
    const error = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;
    console.error = error as typeof console.error;

    await runResolve(ctx, "person@example.com");

    const output = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toEqual({
      workspace: "https://workspace.slack.com",
      lookups: { status: "incomplete", requests: 1, reason: "rate_limited" },
      safe_to_mention: false,
    });
    expect(output).not.toContain("<@");
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("auth refresh restarts workspace proof and the entire direct batch", async () => {
    const calls: ApiCall[] = [];
    let clientAttempts = 0;
    let workAttempts = 0;
    const firstClient = {
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "auth.test") {
          return { url: "https://workspace.slack.com/", team_id: "T12345678" };
        }
        if (method === "users.lookupByEmail") {
          return { user: user("U11111111") };
        }
        throw new Error("invalid_auth");
      },
      lookupUserByEmail: async (email: string) => firstClient.api("users.lookupByEmail", { email }),
    };
    const secondClient = {
      api: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "auth.test") {
          return { url: "https://workspace.slack.com/", team_id: "T12345678" };
        }
        if (method === "users.lookupByEmail") {
          return { user: user("U33333333") };
        }
        return { user: user(String(params.user)) };
      },
      lookupUserByEmail: async (email: string) =>
        secondClient.api("users.lookupByEmail", { email }),
    };
    const ctx = createContext({
      withAutoRefresh: async <T>(input: {
        workspaceUrl: string | undefined;
        work: () => Promise<T>;
      }) => {
        workAttempts += 1;
        try {
          return await input.work();
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("invalid_auth")) {
            throw error;
          }
          workAttempts += 1;
          return input.work();
        }
      },
      getClientForWorkspace: async () => ({
        client: (clientAttempts++ === 0 ? firstClient : secondClient) as never,
        auth: { auth_type: "standard", token: "x" },
        workspace_url: "https://workspace.slack.com",
      }),
    });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await runResolve(ctx, "alice@example.com", "W22222222");

    expect(clientAttempts).toBe(2);
    expect(workAttempts).toBe(2);
    expect(calls.map((call) => call.method)).toEqual([
      "auth.test",
      "users.lookupByEmail",
      "users.info",
      "auth.test",
      "users.lookupByEmail",
      "users.info",
    ]);
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain("<@U33333333>");
    expect(output).toContain("<@W22222222>");
    expect(output).not.toContain("U11111111");
    expect(process.exitCode).toBe(0);
  });

  test("rejects a selected workspace that does not match auth.test", async () => {
    const calls: ApiCall[] = [];
    const ctx = createContext({
      api: async (method, params) => {
        calls.push({ method, params });
        return { url: "https://actual.slack.com/", team_id: "T12345678" };
      },
      canonicalWorkspace: "https://selected.slack.com",
    });
    const log = mock((_value?: unknown) => {});
    const error = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;
    console.error = error as typeof console.error;

    await runResolve(ctx, "U11111111", "--workspace", "selected");

    expect(calls).toEqual([{ method: "auth.test", params: {} }]);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  test("uses the workspace proven by auth.test when none was configured", async () => {
    const ctx = createContext({
      canonicalWorkspace: null,
      api: async (method, params) => {
        if (method === "auth.test") {
          return { url: "https://actual.slack.com/", team_id: "T12345678" };
        }
        return { user: user(String(params.user)) };
      },
    });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await runResolve(ctx, "U11111111");

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      workspace: "https://actual.slack.com",
      safe_to_mention: true,
    });
  });

  test("makes workspace-resolution errors inert", async () => {
    const ctx = createContext({
      getClientForWorkspace: async () => {
        throw new Error(
          'No configured workspace matches selector "<@U99999999> <!here> @channel".',
        );
      },
    });
    const log = mock((_value?: unknown) => {});
    const error = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;
    console.error = error as typeof console.error;

    await runResolve(ctx, "U11111111", "--workspace", "<@U99999999>");

    expect(log).not.toHaveBeenCalled();
    const output = String(error.mock.calls[0]?.[0]);
    expect(output).not.toContain("<@");
    expect(output).not.toContain("<!");
    expect(process.exitCode).toBe(1);
  });

  test("rejects names and handles before calling Slack", async () => {
    let apiCalls = 0;
    const ctx = createContext({
      api: async () => {
        apiCalls += 1;
        return {};
      },
    });
    const error = mock((_value?: unknown) => {});
    console.error = error as typeof console.error;

    await runResolve(ctx, "@alice");

    expect(apiCalls).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  test("rejects an oversized batch before calling auth.test", async () => {
    let apiCalls = 0;
    const ctx = createContext({
      api: async () => {
        apiCalls += 1;
        return {};
      },
    });
    const error = mock((_value?: unknown) => {});
    console.error = error as typeof console.error;

    await runResolve(
      ctx,
      ...Array.from({ length: 21 }, (_, index) => `person-${index}@example.com`),
    );

    expect(apiCalls).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
});
