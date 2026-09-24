import type { Argument, Command, Option } from "commander";
import { pruneEmpty } from "../lib/compact-json.ts";

function findCommand(program: Command, path: string[]): Command {
  let command = program;
  for (const name of path) {
    const next = command.commands.find((candidate) => candidate.name() === name);
    if (!next) {
      throw new Error(`Unknown command path: ${path.join(" ")}`);
    }
    command = next;
  }
  return command;
}

function describeArgument(argument: Argument): Record<string, unknown> {
  return pruneEmpty({
    name: argument.name(),
    description: argument.description,
    required: argument.required ? true : undefined,
    variadic: argument.variadic ? true : undefined,
    default_value: argument.defaultValue,
  }) as Record<string, unknown>;
}

function describeOption(option: Option): Record<string, unknown> {
  return pruneEmpty({
    flags: option.flags,
    description: option.description,
    required: option.mandatory ? true : undefined,
    variadic: option.variadic ? true : undefined,
    default_value: option.defaultValue,
  }) as Record<string, unknown>;
}

export function buildCommandDescription(program: Command, path: string[]): Record<string, unknown> {
  if (path.length === 0) {
    throw new Error("describe requires a command path");
  }
  const command = findCommand(program, path);
  return pruneEmpty({
    schema_version: 1,
    command: path.join(" "),
    description: command.description(),
    arguments: command.registeredArguments.map(describeArgument),
    options: command.options.map(describeOption),
    subcommands: command.commands.map((child) => ({
      name: child.name(),
      description: child.description(),
    })),
  }) as Record<string, unknown>;
}

export function registerDescribeCommand(program: Command): void {
  program
    .command("describe")
    .description("Describe one command as compact machine-readable JSON")
    .argument("<path...>", "Command path, for example: message list")
    .action((path: string[]) => {
      try {
        console.log(JSON.stringify(buildCommandDescription(program, path), null, 2));
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
