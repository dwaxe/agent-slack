import type { Command } from "commander";
import { pruneEmpty } from "../lib/compact-json.ts";
import { makeStrictUserOutputInert } from "../slack/strict-user-resolution.ts";
import {
  getExactUserGroup,
  incompleteUserGroupLookup,
  incompleteUserGroupResolution,
  resolveStrictUserGroups,
  UserGroupDirectoryRequestError,
} from "../slack/usergroups.ts";
import type { CliContext } from "./context.ts";

type WorkspaceOption = { workspace?: string };

export function registerUserGroupCommand(input: { program: Command; ctx: CliContext }): void {
  const userGroupCmd = input.program
    .command("usergroup")
    .description("Workspace user-group directory");

  userGroupCmd
    .command("get")
    .description("Get one exact active or disabled user group without constructing a mention")
    .argument("<group>", "User-group ID (S...) or exact @handle/handle")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [group, options] = args as [string, WorkspaceOption];
      const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
      let resolvedWorkspaceUrl: string | undefined;
      try {
        const lookup = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
            resolvedWorkspaceUrl = normalizeWorkspaceUrl(input.ctx, workspace_url);
            return await getExactUserGroup({ client, identity: group });
          },
        });
        console.log(
          JSON.stringify(pruneEmpty({ workspace: resolvedWorkspaceUrl, ...lookup }), null, 2),
        );
        if (
          lookup.directory.status !== "complete" ||
          !("result" in lookup) ||
          lookup.result.status === "not_found" ||
          lookup.result.status === "ambiguous"
        ) {
          process.exitCode = 1;
        }
      } catch (error: unknown) {
        if (error instanceof UserGroupDirectoryRequestError) {
          const lookup = incompleteUserGroupLookup(error.reason);
          console.log(
            JSON.stringify(pruneEmpty({ workspace: resolvedWorkspaceUrl, ...lookup }), null, 2),
          );
          process.exitCode = 1;
          return;
        }
        console.error(makeStrictUserOutputInert(input.ctx.errorMessage(error)));
        process.exitCode = 1;
      }
    });

  userGroupCmd
    .command("resolve")
    .description("Resolve exact active user groups with all-or-none mentions")
    .argument("<groups...>", "User-group IDs (S...) or exact @handles/handles")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; required if you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [groups, options] = args as [string[], WorkspaceOption];
      const workspaceUrl = input.ctx.effectiveWorkspaceUrl(options.workspace);
      let resolvedWorkspaceUrl: string | undefined;
      try {
        const resolution = await input.ctx.withAutoRefresh({
          workspaceUrl,
          work: async () => {
            const { client, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
            resolvedWorkspaceUrl = normalizeWorkspaceUrl(input.ctx, workspace_url);
            return await resolveStrictUserGroups({ client, identities: groups });
          },
        });
        console.log(
          JSON.stringify(pruneEmpty({ workspace: resolvedWorkspaceUrl, ...resolution }), null, 2),
        );
        if (!resolution.safe_to_mention) {
          process.exitCode = 1;
        }
      } catch (error: unknown) {
        if (error instanceof UserGroupDirectoryRequestError) {
          const resolution = incompleteUserGroupResolution(error.reason);
          console.log(
            JSON.stringify(pruneEmpty({ workspace: resolvedWorkspaceUrl, ...resolution }), null, 2),
          );
          process.exitCode = 1;
          return;
        }
        console.error(makeStrictUserOutputInert(input.ctx.errorMessage(error)));
        process.exitCode = 1;
      }
    });
}

function normalizeWorkspaceUrl(
  ctx: CliContext,
  workspaceUrl: string | undefined,
): string | undefined {
  if (!workspaceUrl) {
    return undefined;
  }
  try {
    return ctx.normalizeUrl(workspaceUrl);
  } catch {
    return undefined;
  }
}
