import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { getCachedUserById } from "../slack/user-cache.ts";
import { isUserId } from "../slack/user-id.ts";
import { getDmChannelForUsers, getUser, listUsers } from "../slack/users.ts";
import {
  resolveStrictUserIdentities,
  type UserResolution,
} from "../slack/strict-user-resolution.ts";

const USER_RESOLUTION_ERROR = "Unable to resolve users safely.";
const SLACK_WORKSPACE_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:slack\.com|slack-gov\.com)$/;

export function registerUserCommand(input: { program: Command; ctx: CliContext }): void {
  const userCmd = input.program.command("user").description("Workspace user directory");

  userCmd
    .command("list")
    .description("List users in the workspace")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .option("--limit <n>", "Max users (default 200)", "200")
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--include-bots", "Include bot users")
    .action(async (...args) => {
      const [options] = args as [
        { workspace?: string; limit: string; cursor?: string; includeBots?: boolean },
      ];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            const limit = Number.parseInt(options.limit, 10);
            return await listUsers(client, {
              limit,
              cursor: options.cursor,
              includeBots: Boolean(options.includeBots),
            });
          },
        });
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  userCmd
    .command("resolve")
    .description("Verify active humans by Slack user ID or email")
    .argument("<identities...>", "Canonical U/W user IDs or email addresses")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [identities, options] = args as [string[], { workspace?: string }];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const output = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
            const workspace = requireSlackWorkspaceOrigin(workspace_url);
            const resolution = await resolveStrictUserIdentities({ client, identities });
            return { workspace, resolution };
          },
        });
        printUserResolution(output.workspace, output.resolution);
        if (!output.resolution.safe_to_mention) {
          process.exitCode = 1;
        }
      } catch {
        console.error(USER_RESOLUTION_ERROR);
        process.exitCode = 1;
      }
    });

  userCmd
    .command("get")
    .description("Get a single workspace user")
    .argument("<user>", "User ID (U.../W...) or @handle/handle")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .option("--refresh", "Refresh an exact-ID profile instead of using the cache")
    .option("--no-cache", "Fetch without reading or writing the profile cache")
    .action(async (...args) => {
      const [user, options] = args as [
        string,
        { workspace?: string; refresh?: boolean; cache?: boolean },
      ];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
            const userId = user.trim();
            if (!isUserId(userId) || options.cache === false) {
              return await getUser(client, user);
            }
            const profile = await getCachedUserById({
              client,
              workspaceUrl: workspace_url ?? "",
              userId,
              forceRefresh: Boolean(options.refresh),
            });
            if (!profile) {
              throw new Error("users.info returned no user");
            }
            return profile;
          },
        });
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  userCmd
    .command("dm-open")
    .description("Open or get a DM / group DM channel")
    .argument("<users...>", "One to 8 other user IDs (U.../W...) or @handles; caller is implicit")
    .option("--workspace <url>", "Workspace URL (required if you have multiple workspaces)")
    .action(async (...args) => {
      const [users, options] = args as [string[], { workspace?: string }];
      try {
        const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const payload = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client } = await input.ctx.getClientForWorkspace(workspaceUrl);
            return await getDmChannelForUsers(client, users);
          },
        });
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}

function requireSlackWorkspaceOrigin(workspaceUrl: string | undefined): string {
  const url = workspaceUrl && URL.canParse(workspaceUrl) ? new URL(workspaceUrl) : null;
  if (
    !url ||
    url.protocol !== "https:" ||
    url.origin !== workspaceUrl ||
    !SLACK_WORKSPACE_HOST.test(url.hostname)
  ) {
    throw new Error("Resolved workspace is not a canonical Slack origin");
  }
  return workspaceUrl;
}

function printUserResolution(workspace: string, resolution: UserResolution): void {
  console.log(JSON.stringify(pruneEmpty({ workspace, ...resolution }), null, 2));
}
