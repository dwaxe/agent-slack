import { describe, expect, test } from "bun:test";
import { commandTimeoutMs, shouldStartCommandWatchdog } from "../src/cli/command-watchdog.ts";

describe("command watchdog", () => {
  test("allows the bounded own-message export window", () => {
    expect(commandTimeoutMs(["message", "export-own"], {})).toBe(600_000);
    expect(commandTimeoutMs(["message", "scheduled", "cancel", "Q123"], {})).toBe(600_000);
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
