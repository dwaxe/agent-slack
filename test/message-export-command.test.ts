import { afterEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { registerMessageExportCommand } from "../src/cli/message-export-command.ts";

const originalLog = console.log;
const originalError = console.error;

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = 0;
});

function buildProgram(ctx: CliContext): Command {
  const program = new Command();
  const messageCmd = program.command("message");
  registerMessageExportCommand({ messageCmd, ctx });
  return program;
}

function buildContext(getClientForWorkspace: CliContext["getClientForWorkspace"]): CliContext {
  return {
    effectiveWorkspaceUrl: (flag?: string) => flag,
    withAutoRefresh: async <T>(input: {
      workspaceUrl: string | undefined;
      work: () => Promise<T>;
    }) => input.work(),
    getClientForWorkspace,
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  } as CliContext;
}

describe("message export-own command", () => {
  test("pins a selector to the exact resolved Slack workspace URL", async () => {
    const seenSelectors: (string | undefined)[] = [];
    const client = {
      api: async (method: string) => {
        if (method === "auth.test") {
          return {
            team_id: "T12345678",
            user_id: "U12345678",
            url: "https://workspace.slack.com/",
          };
        }
        if (method === "search.messages") {
          return { messages: { paging: { page: 1, pages: 1 }, matches: [] } };
        }
        throw new Error(`Unexpected API method: ${method}`);
      },
    };
    const ctx = buildContext(async (selector) => {
      seenSelectors.push(selector);
      return {
        client: client as never,
        auth: { auth_type: "standard", token: "unused" },
        workspace_url: "https://Workspace.slack.com/path-is-discarded",
      };
    });
    const output: string[] = [];
    console.log = mock((value: string) => output.push(value)) as typeof console.log;

    await buildProgram(ctx).parseAsync(
      ["message", "export-own", "--workspace", "workspace", "--oldest", "1800000000.000001"],
      { from: "user" },
    );

    expect(seenSelectors).toEqual(["workspace"]);
    const payload = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(payload).toEqual({
      schema_version: 1,
      complete: true,
      workspace_url: "https://workspace.slack.com",
      team_id: "T12345678",
      user_id: "U12345678",
      oldest: "1800000000.000001",
      latest: null,
      messages: [],
    });
  });

  test("discovers the workspace from auth.test for token-only configuration", async () => {
    const client = {
      api: async (method: string) => {
        if (method === "auth.test") {
          return {
            team_id: "T12345678",
            user_id: "U12345678",
            url: "https://workspace.slack.com/",
          };
        }
        return { messages: { paging: { page: 1, pages: 1 }, matches: [] } };
      },
    };
    const ctx = buildContext(async () => ({
      client: client as never,
      auth: { auth_type: "standard", token: "unused" },
      workspace_url: undefined,
    }));
    const output: string[] = [];
    console.log = mock((value: string) => output.push(value)) as typeof console.log;

    await buildProgram(ctx).parseAsync(["message", "export-own", "--oldest", "1800000000.000001"], {
      from: "user",
    });

    expect(JSON.parse(output[0]!).workspace_url).toBe("https://workspace.slack.com");
  });

  test("surfaces an invalid workspace selector without calling Slack", async () => {
    const ctx = buildContext(async () => {
      throw new Error('No configured workspace matches selector "missing"');
    });
    const errors: string[] = [];
    console.error = mock((value: string) => errors.push(value)) as typeof console.error;

    await buildProgram(ctx).parseAsync(
      ["message", "export-own", "--workspace", "missing", "--oldest", "1800000000.000001"],
      { from: "user" },
    );

    expect(process.exitCode).toBe(1);
    expect(errors).toEqual(['No configured workspace matches selector "missing"']);
  });

  test("rejects a resolved non-URL workspace before Slack access", async () => {
    let apiCalled = false;
    const ctx = buildContext(async () => ({
      client: {
        api: async () => {
          apiCalled = true;
          return {};
        },
      } as never,
      auth: { auth_type: "standard", token: "unused" },
      workspace_url: "not-a-url",
    }));
    const errors: string[] = [];
    console.error = mock((value: string) => errors.push(value)) as typeof console.error;

    await buildProgram(ctx).parseAsync(["message", "export-own", "--oldest", "1800000000.000001"], {
      from: "user",
    });

    expect(apiCalled).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(errors[0]).toContain("Invalid workspace URL");
  });

  test("rejects a resolved non-HTTPS workspace before Slack access", async () => {
    const ctx = buildContext(async () => ({
      client: {} as never,
      auth: { auth_type: "standard", token: "unused" },
      workspace_url: "http://workspace.slack.com",
    }));
    const errors: string[] = [];
    console.error = mock((value: string) => errors.push(value)) as typeof console.error;

    await buildProgram(ctx).parseAsync(["message", "export-own", "--oldest", "1800000000.000001"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
    expect(errors).toEqual(["Slack workspace URL must use https"]);
  });

  test("accepts a resolved Slack Gov workspace origin", async () => {
    const client = {
      api: async (method: string) => {
        if (method === "auth.test") {
          return {
            team_id: "T12345678",
            user_id: "U12345678",
            url: "https://workspace.slack-gov.com/",
          };
        }
        return { messages: { paging: { page: 1, pages: 1 }, matches: [] } };
      },
    };
    const ctx = buildContext(async () => ({
      client: client as never,
      auth: { auth_type: "standard", token: "unused" },
      workspace_url: "https://workspace.slack-gov.com",
    }));
    const output: string[] = [];
    console.log = mock((value: string) => output.push(value)) as typeof console.log;

    await buildProgram(ctx).parseAsync(["message", "export-own", "--oldest", "1800000000.000001"], {
      from: "user",
    });

    expect(JSON.parse(output[0]!).workspace_url).toBe("https://workspace.slack-gov.com");
  });
});
