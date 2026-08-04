import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { registerUserGroupCommand } from "../src/cli/usergroup-command.ts";

function createContext(input: {
  api?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  withAutoRefresh?: CliContext["withAutoRefresh"];
  getClientForWorkspace?: CliContext["getClientForWorkspace"];
}) {
  const client = {
    api:
      input.api ??
      (async () => {
        throw new Error("Unexpected Slack API call");
      }),
  };
  return {
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
        auth: { auth_type: "standard" as const, token: "x" },
        workspace_url: "https://workspace.slack.com",
      })),
    normalizeUrl: (value: string) => {
      const url = new URL(value);
      return `${url.protocol}//${url.host}`;
    },
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    parseContentType: () => "any" as const,
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
  } satisfies CliContext;
}

function activeGroup(id = "S11111111", handle = "cloud-team") {
  return {
    id,
    handle,
    name: "Cloud Team",
    is_usergroup: true,
    date_delete: 0,
  };
}

describe("usergroup command", () => {
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

  test("resolve prints canonical workspace and one atomic mention", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext({
      api: async (method, params) => {
        calls.push({ method, params });
        return { usergroups: [activeGroup()] };
      },
    });
    const program = new Command();
    registerUserGroupCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await program.parseAsync(["usergroup", "resolve", "@cloud-team", "--workspace", "workspace"], {
      from: "user",
    });

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      workspace: "https://workspace.slack.com",
      safe_to_mention: true,
      results: [{ mention: "<!subteam^S11111111>" }],
    });
    expect(process.exitCode).toBe(0);
  });

  test("resolve exits nonzero and suppresses all mentions for an unsafe batch", async () => {
    const ctx = createContext({
      api: async () => ({ usergroups: [activeGroup()] }),
    });
    const program = new Command();
    registerUserGroupCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await program.parseAsync(["usergroup", "resolve", "@cloud-team", "@missing"], {
      from: "user",
    });

    const output = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(output).safe_to_mention).toBe(false);
    expect(output).not.toContain("<!subteam^");
    expect(process.exitCode).toBe(1);
  });

  test("get returns disabled metadata without a live mention and exits successfully", async () => {
    const ctx = createContext({
      api: async () => ({
        usergroups: [activeGroup("S11111111", "retired")].map((group) => ({
          ...group,
          date_delete: 123,
        })),
      }),
    });
    const program = new Command();
    registerUserGroupCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await program.parseAsync(["usergroup", "get", "@retired"], { from: "user" });

    const output = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      result: { status: "inactive", group: { id: "S11111111", handle: "retired" } },
    });
    expect(output).not.toContain("<!subteam^");
    expect(process.exitCode).toBe(0);
  });

  test("prints structured incomplete output for a terminal request failure", async () => {
    const ctx = createContext({
      api: async () => {
        throw new Error("Slack API usergroups.list missing_scope");
      },
    });
    const program = new Command();
    registerUserGroupCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    const error = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;
    console.error = error as typeof console.error;

    await program.parseAsync(["usergroup", "resolve", "@cloud-team"], { from: "user" });

    const output = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      directory: { status: "incomplete", reason: "missing_scope" },
      safe_to_mention: false,
    });
    expect(output).not.toContain("<!subteam^");
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("auto-refresh retries the complete snapshot with a fresh client", async () => {
    let clientAttempts = 0;
    let workAttempts = 0;
    const firstClient = {
      api: async () => {
        throw new Error("invalid_auth");
      },
    };
    const secondClient = {
      api: async () => ({ usergroups: [activeGroup()] }),
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
    const program = new Command();
    registerUserGroupCommand({ program, ctx });
    const log = mock((_value?: unknown) => {});
    console.log = log as typeof console.log;

    await program.parseAsync(["usergroup", "resolve", "@cloud-team"], { from: "user" });

    expect(clientAttempts).toBe(2);
    expect(workAttempts).toBe(2);
    expect(String(log.mock.calls[0]?.[0])).toContain("<!subteam^S11111111>");
    expect(process.exitCode).toBe(0);
  });
});
