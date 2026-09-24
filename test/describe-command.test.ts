import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.ts";
import { buildCommandDescription, registerDescribeCommand } from "../src/cli/describe-command.ts";
import { registerMessageCommand } from "../src/cli/message-command.ts";
import { registerSearchCommand } from "../src/cli/search-command.ts";

function buildProgram(): Command {
  const program = new Command();
  const ctx = {} as CliContext;
  registerMessageCommand({ program, ctx });
  registerSearchCommand({ program, ctx });
  registerDescribeCommand(program);
  return program;
}

describe("machine-readable command descriptions", () => {
  test("describes one leaf without emitting the full command catalog", () => {
    const description = buildCommandDescription(buildProgram(), ["search", "batch"]);

    expect(description).toMatchObject({
      schema_version: 1,
      command: "search batch",
      description: "Run bounded message queries and return deduplicated verified refs",
    });
    expect(description.arguments).toEqual([
      expect.objectContaining({ name: "queries-file", required: true }),
    ]);
    expect(description.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ flags: "--max-results <n>" })]),
    );
    expect(description.subcommands).toBeUndefined();
  });

  test("reports unknown command paths", () => {
    expect(() => buildCommandDescription(buildProgram(), ["message", "missing"])).toThrow(
      "Unknown command path: message missing",
    );
  });
});
