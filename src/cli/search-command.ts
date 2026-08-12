import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { searchSlack } from "../slack/search.ts";

type SearchCommandOptions = {
  workspace?: string;
  channel?: string[] | string;
  user?: string;
  after?: string;
  before?: string;
  contentType?: string;
  limit?: string;
  maxContentChars?: string;
  resolveUsers?: boolean;
  refreshUsers?: boolean;
  requireCompleteResults?: boolean;
  metadataOnly?: boolean;
};

function pruneSearchPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const pruned = pruneEmpty(payload) as Record<string, unknown>;
  if (payload.metadata_only === true && Array.isArray(payload.messages)) {
    pruned.messages = payload.messages;
  }
  return pruned;
}

function addSearchOptions(cmd: Command): Command {
  return cmd
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; needed when searching across multiple workspaces)",
    )
    .option("--channel <channel...>", "Channel filter (#name, name, or id). Repeatable.")
    .option("--user <user>", "User filter (U.../W..., @handle, or handle)")
    .option("--after <date>", "Only results after YYYY-MM-DD")
    .option("--before <date>", "Only results before YYYY-MM-DD")
    .option(
      "--content-type <type>",
      "Filter content type: any|text|image|snippet|file (default any)",
    )
    .option("--limit <n>", "Max results (default 20)", "20")
    .option(
      "--max-content-chars <n>",
      "Max message content characters (default 4000, -1 for unlimited)",
      "4000",
    )
    .option("--resolve-users", "Resolve user IDs to user profiles")
    .option(
      "--refresh-users",
      "Refresh user profile cache before resolving referenced users (implies --resolve-users)",
    );
}

async function runSearch(input: {
  ctx: CliContext;
  kind: "messages" | "files" | "all";
  query: string;
  options: SearchCommandOptions;
}): Promise<void> {
  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  const channels = Array.isArray(input.options.channel)
    ? input.options.channel
    : input.options.channel
      ? [input.options.channel]
      : [];

  await input.ctx.assertWorkspaceSpecifiedForChannelNames({ workspaceUrl, channels });

  const payload = await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client, auth, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const limit = Number.parseInt(input.options.limit || "20", 10);
      const maxContentChars = Number.parseInt(input.options.maxContentChars || "4000", 10);
      const contentType = input.ctx.parseContentType(input.options.contentType);
      const metadataOnly = Boolean(input.options.metadataOnly);
      return await searchSlack({
        client,
        auth,
        options: {
          workspace_url: workspace_url ?? workspaceUrl ?? "",
          query: input.query,
          kind: input.kind,
          channels,
          user: input.options.user,
          after: input.options.after,
          before: input.options.before,
          content_type: contentType,
          limit,
          max_content_chars: maxContentChars,
          download: !metadataOnly,
          resolve_users: Boolean(input.options.resolveUsers || input.options.refreshUsers),
          refresh_users: Boolean(input.options.refreshUsers),
          require_complete_results: Boolean(input.options.requireCompleteResults || metadataOnly),
          metadata_only: metadataOnly,
        },
      });
    },
  });

  console.log(JSON.stringify(pruneSearchPayload(payload), null, 2));
}

export function registerSearchCommand(input: { program: Command; ctx: CliContext }): void {
  const searchCmd = input.program
    .command("search")
    .description("Search Slack messages and files (token-efficient JSON)");

  const create = (spec: {
    kind: "messages" | "files" | "all";
    name: string;
    desc: string;
  }): Command => {
    const command = addSearchOptions(searchCmd.command(spec.name).description(spec.desc));
    if (spec.kind === "messages") {
      command.option(
        "--require-complete-results",
        "Fail instead of skipping any malformed, unresolvable, or unfetchable message result",
      );
      command.option(
        "--metadata-only",
        "Return verified channel_id, ts, and permalink refs only; implies strict complete results and no downloads",
      );
    }
    return command.argument("<query>", "Search query").action(async (...args) => {
      const [query, options] = args as [string, SearchCommandOptions];
      try {
        await runSearch({ ctx: input.ctx, kind: spec.kind, query, options });
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
  };

  create({ kind: "all", name: "all", desc: "Search messages and files" });
  create({ kind: "messages", name: "messages", desc: "Search messages" });
  create({ kind: "files", name: "files", desc: "Search files" });
}
