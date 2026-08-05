import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerUserCommand } from "../src/cli/user-command.ts";
import type { CliContext } from "../src/cli/context.ts";

describe("user get profile cache", () => {
  const originalLog = console.log;
  const originalXdg = process.env.XDG_RUNTIME_DIR;
  let runtimeDir = "";

  beforeEach(async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), "agent-slack-user-command-cache-test-"));
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    console.log = () => {};
  });

  afterEach(async () => {
    console.log = originalLog;
    if (originalXdg === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = originalXdg;
    }
    await rm(runtimeDir, { recursive: true, force: true });
  });

  test("reuses exact-ID profiles and refreshes on request", async () => {
    let userInfoCalls = 0;
    const output: string[] = [];
    const client = {
      cacheScopeKey: () => "test-principal",
      api: async (method: string) => {
        expect(method).toBe("users.info");
        userInfoCalls += 1;
        return {
          user: {
            id: "U11111111",
            name: `alice-${userInfoCalls}`,
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
      },
    };
    const ctx = {
      effectiveWorkspaceUrl: () => "https://workspace.slack.com",
      withAutoRefresh: async <T>(input: { work: () => Promise<T> }) => input.work(),
      getClientForWorkspace: async () => ({
        client,
        workspace_url: "https://workspace.slack.com",
      }),
      errorMessage: (error: unknown) => String(error),
    } as unknown as CliContext;
    const program = new Command();
    registerUserCommand({ program, ctx });
    console.log = (value?: unknown) => output.push(String(value));

    await program.parseAsync(["user", "get", "U11111111"], { from: "user" });
    await program.parseAsync(["user", "get", "U11111111"], { from: "user" });
    expect(userInfoCalls).toBe(1);
    expect(output[1]).toBe(output[0]);
    expect(JSON.parse(output[0]!)).toEqual({
      id: "U11111111",
      name: "alice-1",
      real_name: "Alice Example",
      display_name: "Alice",
      email: "alice@example.com",
      title: "Engineer",
      tz: "America/Los_Angeles",
      status_text: "Heads down",
      status_emoji: ":computer:",
      status_expiration: 123,
    });

    await program.parseAsync(["user", "get", "U11111111", "--refresh"], { from: "user" });
    expect(userInfoCalls).toBe(2);

    await program.parseAsync(["user", "get", "U11111111", "--no-cache"], { from: "user" });
    expect(userInfoCalls).toBe(3);

    await program.parseAsync(["user", "get", "U11111111"], { from: "user" });
    expect(userInfoCalls).toBe(3);
    expect(JSON.parse(output[2]!).name).toBe("alice-2");
    expect(JSON.parse(output[3]!).name).toBe("alice-3");
    expect(output[4]).toBe(output[2]);
  });
});
