import { afterEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { registerMessageCommand } from "../src/cli/message-command.ts";
import {
  isSafeModeEnabled,
  redirectSendToDraft,
  safeModeBlockedError,
} from "../src/cli/safe-mode.ts";

const stubCtx = {} as CliContext;

describe("isSafeModeEnabled", () => {
  test("enabled via CLI flag", () => {
    expect(isSafeModeEnabled({ cliFlag: true, env: {} })).toBe(true);
  });

  test.each(["1", "true", "TRUE", "yes", "on", " 1 "])("enabled for env value %p", (value) => {
    expect(isSafeModeEnabled({ env: { AGENT_SLACK_SAFE_MODE: value } })).toBe(true);
  });

  test.each(["0", "false", "off", "no", ""])("disabled for env value %p", (value) => {
    expect(isSafeModeEnabled({ env: { AGENT_SLACK_SAFE_MODE: value } })).toBe(false);
  });

  test("disabled when env var is unset and flag is absent", () => {
    expect(isSafeModeEnabled({ env: {} })).toBe(false);
    expect(isSafeModeEnabled({ cliFlag: false, env: {} })).toBe(false);
  });
});

describe("safeModeBlockedError", () => {
  test("names the blocked action", () => {
    expect(safeModeBlockedError("edit").message).toContain('"message edit" is blocked');
    expect(safeModeBlockedError("delete").message).toContain('"message delete" is blocked');
  });
});

test("safe mode blocks CI compose before workspace or API work", async () => {
  const originalCi = process.env.CI;
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const originalError = console.error;
  const log = mock(() => {});
  const error = mock(() => {});
  const noWorkCtx = {
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  } as CliContext;

  try {
    process.env.CI = "1";
    process.exitCode = 0;
    console.log = log as typeof console.log;
    console.error = error as typeof console.error;

    const program = new Command().option("--safe-mode");
    registerMessageCommand({ program, ctx: noWorkCtx });
    await program.parseAsync(
      ["--safe-mode", "message", "compose", "C12345678", "review this first"],
      { from: "user" },
    );

    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'Safe mode is active: "message compose" cannot skip the editor in CI because that would post without human review.',
    );
    expect(process.exitCode).toBe(1);
  } finally {
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
    process.exitCode = originalExitCode ?? 0;
    console.log = originalLog;
    console.error = originalError;
  }
});

describe("redirectSendToDraft", () => {
  const originalCi = process.env.CI;

  afterEach(() => {
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
  });

  test.each([
    [{ attach: ["./report.md"] }, "--attach"],
    [{ blocks: "/tmp/blocks.json" }, "--blocks"],
    [{ schedule: "2030-01-01T00:00:00Z" }, "--schedule"],
    [{ scheduleIn: "3h" }, "--schedule-in"],
    [{ replyBroadcast: true }, "--reply-broadcast"],
  ])("rejects unsupported send option %p", async (options, flag) => {
    await expect(
      redirectSendToDraft({ ctx: stubCtx, targetInput: "#general", text: "hi", options }),
    ).rejects.toThrow(flag);
  });

  test("lists all unsupported flags at once", async () => {
    const promise = redirectSendToDraft({
      ctx: stubCtx,
      targetInput: "#general",
      text: "hi",
      options: { attach: ["./a.md"], scheduleIn: "3h" },
    });
    await expect(promise).rejects.toThrow("--attach, --schedule-in");
  });

  test("rejects in CI where no interactive editor is available", async () => {
    process.env.CI = "1";
    await expect(
      redirectSendToDraft({ ctx: stubCtx, targetInput: "#general", text: "hi", options: {} }),
    ).rejects.toThrow("unavailable in CI");
  });

  test("opens a draft with the send text and thread context", async () => {
    delete process.env.CI;
    const draftCalls: unknown[] = [];
    const payload = await redirectSendToDraft(
      {
        ctx: stubCtx,
        targetInput: "#general",
        text: "here's the report",
        options: { workspace: "myteam", threadTs: "1770165109.628379" },
      },
      async (input) => {
        draftCalls.push(input);
        return { ok: true, sent: true };
      },
    );
    expect(draftCalls).toEqual([
      {
        ctx: stubCtx,
        targetInput: "#general",
        initialText: "here's the report",
        options: { workspace: "myteam", threadTs: "1770165109.628379" },
      },
    ]);
    expect(payload).toEqual({
      safe_mode: true,
      redirected_from: "send",
      ok: true,
      sent: true,
    });
  });
});
