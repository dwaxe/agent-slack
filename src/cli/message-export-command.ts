import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { exportOwnMessages } from "../slack/own-message-export.ts";

export function registerMessageExportCommand(input: {
  messageCmd: Command;
  ctx: CliContext;
}): void {
  input.messageCmd
    .command("export-own")
    .description(
      "Export the authenticated user's own public/private-channel text without message hydration or file downloads",
    )
    .option(
      "--workspace <url>",
      "Pin one workspace by full URL or unique selector (uses the exact resolved default when omitted)",
    )
    .requiredOption("--oldest <ts>", "Exact inclusive Slack timestamp (seconds.microseconds)")
    .option("--latest <ts>", "Exact inclusive Slack timestamp (seconds.microseconds)")
    .action(async (...args) => {
      const [options] = args as [
        {
          workspace?: string;
          oldest: string;
          latest?: string;
        },
      ];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const resolved = await input.ctx.getClientForWorkspace(workspaceUrl);
            const workspaceClaim = resolved.workspace_url
              ? normalizeWorkspaceUrl(resolved.workspace_url)
              : workspaceUrl;
            return exportOwnMessages({
              client: resolved.client,
              workspaceUrl: workspaceClaim,
              oldest: options.oldest,
              latest: options.latest,
            });
          },
        });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}

function normalizeWorkspaceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid workspace URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("Slack workspace URL must use https");
  }
  if (!/^.+\.(?:slack\.com|slack-gov\.com)$/i.test(url.hostname)) {
    throw new Error(`Not a Slack workspace URL: ${url.hostname}`);
  }
  if (url.username || url.password || url.port) {
    throw new Error("Slack workspace URL must not include credentials or a custom port");
  }
  return `https://${url.hostname.toLowerCase()}`;
}
