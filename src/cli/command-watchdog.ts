const GLOBAL_BOOLEAN_OPTIONS = new Set(["--safe-mode"]);
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const LONG_RUNNING_COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;

export function commandTimeoutMs(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_SLACK_COMMAND_TIMEOUT_MS?.trim();
  const fallback = isLongRunningMessageScan(normalizedCommandArgs(args))
    ? LONG_RUNNING_COMMAND_TIMEOUT_MS
    : DEFAULT_COMMAND_TIMEOUT_MS;
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function shouldStartCommandWatchdog(args: string[]): boolean {
  const [command, subcommand] = args;
  if (!command || command === "update") {
    return false;
  }
  if (command === "message" && subcommand === "draft") {
    return false;
  }
  const [normalizedCommand, normalizedSubcommand] = normalizedCommandArgs(args);
  if (normalizedCommand === "user" && normalizedSubcommand === "resolve") {
    return false;
  }
  return true;
}

function normalizedCommandArgs(args: string[]): string[] {
  return args.filter((arg) => !GLOBAL_BOOLEAN_OPTIONS.has(arg));
}

function isLongRunningMessageScan(args: string[]): boolean {
  return (
    (args[0] === "message" && args[1] === "export-own") ||
    (args[0] === "message" && args[1] === "scheduled" && args[2] === "cancel")
  );
}
