import { describe, expect, test } from "bun:test";
import { commandTimeoutMs, shouldStartCommandWatchdog } from "../src/cli/command-watchdog.ts";

describe("command watchdog", () => {
  test("never caps complete user resolution regardless of global option order", () => {
    expect(shouldStartCommandWatchdog(["user", "resolve", "@alice"])).toBe(false);
    expect(shouldStartCommandWatchdog(["--safe-mode", "user", "resolve", "@alice"])).toBe(false);
    expect(shouldStartCommandWatchdog(["user", "--safe-mode", "resolve", "@alice"])).toBe(false);
  });

  test("preserves existing watchdog behavior for other command paths", () => {
    expect(shouldStartCommandWatchdog(["message", "draft", "list"])).toBe(false);
    expect(shouldStartCommandWatchdog(["update"])).toBe(false);
    expect(shouldStartCommandWatchdog(["user", "get", "@alice"])).toBe(true);
    expect(shouldStartCommandWatchdog(["--safe-mode", "message", "draft", "list"])).toBe(true);
    expect(shouldStartCommandWatchdog(["--safe-mode", "update"])).toBe(true);
  });

  test("allows the bounded own-message export window", () => {
    expect(commandTimeoutMs(["message", "export-own"], {})).toBe(600_000);
    expect(commandTimeoutMs(["message", "scheduled", "cancel", "Q123"], {})).toBe(600_000);
    expect(commandTimeoutMs(["--safe-mode", "message", "export-own"], {})).toBe(600_000);
    expect(commandTimeoutMs(["message", "scheduled", "--safe-mode", "cancel", "Q123"], {})).toBe(
      600_000,
    );
    expect(shouldStartCommandWatchdog(["message", "export-own"])).toBe(true);
  });

  test("retains the normal timeout and explicit override", () => {
    expect(commandTimeoutMs(["message", "read"], {})).toBe(30_000);
    expect(
      commandTimeoutMs(["message", "export-own"], {
        AGENT_SLACK_COMMAND_TIMEOUT_MS: "45000",
      }),
    ).toBe(45_000);
  });
});
