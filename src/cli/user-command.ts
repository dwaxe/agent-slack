import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import type { SlackApiClient } from "../slack/client.ts";
import { getCachedUserById } from "../slack/user-cache.ts";
import { isUserId } from "../slack/user-id.ts";
import { getDmChannelForUsers, getUser, listUsers } from "../slack/users.ts";
import {
  incompleteStrictUserResolution,
  makeStrictUserOutputInert,
  resolveStrictUserIdentities,
  StrictUserLookupRequestError,
  validateStrictUserIdentityBatch,
} from "../slack/strict-user-resolution.ts";

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
    .description("Verify active humans directly with all-or-none mentions")
    .argument("<identities...>", "At most 20 canonical U/W user IDs or emails")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [identities, options] = args as [string[], { workspace?: string }];
      let workspaceUrl: string | undefined;
      let resolvedWorkspaceUrl: string | undefined;
      try {
        validateStrictUserIdentityBatch(identities);
        workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
        const resolution = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
            const authenticated = await requireAuthenticatedSlackWorkspace(client, workspace_url);
            resolvedWorkspaceUrl = authenticated.workspace;
            return await resolveStrictUserIdentities({
              client,
              identities,
              edgeCacheId: authenticated.edgeCacheId,
            });
          },
        });
        const payload = { workspace: resolvedWorkspaceUrl, ...resolution };
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
        if (!resolution.safe_to_mention) {
          process.exitCode = 1;
        }
      } catch (err: unknown) {
        if (err instanceof StrictUserLookupRequestError) {
          const resolution = incompleteStrictUserResolution({
            requests: err.requests,
            reason: err.reason,
          });
          const payload = { workspace: resolvedWorkspaceUrl, ...resolution };
          console.log(JSON.stringify(pruneEmpty(payload), null, 2));
          process.exitCode = 1;
          return;
        }
        console.error(makeStrictUserOutputInert(input.ctx.errorMessage(err)));
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
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !SLACK_WORKSPACE_HOST.test(url.hostname)
  ) {
    throw new Error("Resolved workspace is not a canonical Slack origin");
  }
  return url.origin;
}

async function requireAuthenticatedSlackWorkspace(
  client: SlackApiClient,
  configuredWorkspaceUrl: string | undefined,
): Promise<{ workspace: string; edgeCacheId: string }> {
  const configuredWorkspace = configuredWorkspaceUrl
    ? requireSlackWorkspaceOrigin(configuredWorkspaceUrl)
    : undefined;
  const auth = await client.api("auth.test", {});
  const authenticatedWorkspace = requireSlackWorkspaceOrigin(
    typeof auth.url === "string" ? auth.url : undefined,
  );
  if (configuredWorkspace && configuredWorkspace !== authenticatedWorkspace) {
    throw new Error("Authenticated Slack workspace does not match the selected workspace");
  }
  const teamId =
    typeof auth.team_id === "string" && /^T[A-Z0-9]{8,}$/.test(auth.team_id)
      ? auth.team_id
      : undefined;
  const enterpriseId =
    typeof auth.enterprise_id === "string" && /^E[A-Z0-9]{8,}$/.test(auth.enterprise_id)
      ? auth.enterprise_id
      : undefined;
  const edgeCacheId = enterpriseId ?? teamId;
  if (!edgeCacheId) {
    throw new Error("Slack auth.test returned no valid team or enterprise ID");
  }
  return { workspace: authenticatedWorkspace, edgeCacheId };
}
