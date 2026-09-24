import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import {
  loadCredentials,
  removeWorkspace,
  setDefaultWorkspace,
  upsertWorkspace,
  upsertWorkspaces,
} from "../auth/store.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { redactSecret } from "../lib/redact.ts";
import { getString, isRecord } from "../lib/object-type-guards.ts";
import { isUserId } from "../slack/user-id.ts";

async function runAuthTest(input: {
  ctx: CliContext;
  workspaceUrl?: string;
}): Promise<Record<string, unknown>> {
  return input.ctx.withAutoRefresh({
    workspaceUrl: input.workspaceUrl,
    work: async () => {
      const { client } = await input.ctx.getClientForWorkspace(input.workspaceUrl);
      return (await client.api("auth.test", {})) as Record<string, unknown>;
    },
  });
}

export async function handleAuthCheck(input: {
  ctx: CliContext;
  workspace?: string;
}): Promise<Record<string, unknown>> {
  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.workspace);
  return await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const {
        client,
        auth: resolvedAuth,
        workspace_url,
      } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const response = await client.api("auth.test", {});
      if (!isRecord(response)) {
        throw new Error("Slack auth.test returned an invalid response");
      }
      const teamId = getString(response.team_id)?.trim();
      const userId = getString(response.user_id)?.trim();
      const authenticatedUrl = getString(response.url)?.trim();
      if (!teamId) {
        throw new Error("Slack auth.test did not return team_id");
      }
      if (!userId || !isUserId(userId)) {
        throw new Error("Slack auth.test did not return a canonical user_id");
      }
      if (!authenticatedUrl) {
        throw new Error("Slack auth.test did not return a workspace URL");
      }
      const actualWorkspace = input.ctx.normalizeUrl(authenticatedUrl);
      const expectedWorkspace = input.ctx.normalizeUrl(workspace_url ?? actualWorkspace);
      if (new URL(actualWorkspace).origin !== new URL(expectedWorkspace).origin) {
        throw new Error("Slack authentication resolved to a different workspace than requested");
      }
      return {
        ok: true,
        workspace_url: new URL(actualWorkspace).origin,
        team_id: teamId,
        user_id: userId,
        auth_type: resolvedAuth.auth_type,
      };
    },
  });
}

export function registerAuthCommand(input: { program: Command; ctx: CliContext }): void {
  const auth = input.program.command("auth").description("Manage Slack authentication");

  auth
    .command("check")
    .description("Verify one workspace and return a compact readiness receipt")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; needed with multiple workspaces)",
    )
    .action(async (...args) => {
      const [options] = args as [{ workspace?: string }];
      try {
        const payload = await handleAuthCheck({ ctx: input.ctx, workspace: options.workspace });
        console.log(JSON.stringify(payload));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  auth
    .command("whoami")
    .description("Show configured workspaces and token sources")
    .action(async () => {
      try {
        const creds = await loadCredentials();
        const sanitized = {
          ...creds,
          workspaces: creds.workspaces.map((w) => ({
            workspace_url: w.workspace_url,
            workspace_name: w.workspace_name,
            auth_type: w.auth.auth_type,
            token:
              w.auth.auth_type === "standard"
                ? redactSecret(w.auth.token)
                : redactSecret(w.auth.xoxc_token),
            cookie_d: w.auth.auth_type === "browser" ? redactSecret(w.auth.xoxd_cookie) : undefined,
          })),
        };
        console.log(JSON.stringify(pruneEmpty(sanitized), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  auth
    .command("test")
    .description("Verify credentials (calls Slack auth.test)")
    .option(
      "--workspace <url>",
      "Workspace selector (full URL or unique substring; needed when you have multiple workspaces)",
    )
    .action(async (...args) => {
      const [options] = args as [{ workspace?: string }];
      try {
        const resp = await runAuthTest({
          ctx: input.ctx,
          workspaceUrl: input.ctx.effectiveWorkspaceUrl(options.workspace),
        });
        console.log(JSON.stringify(pruneEmpty(resp), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  auth
    .command("import-chrome")
    .description("Import xoxc/xoxd from a logged-in Slack tab in Google Chrome (macOS)")
    .action(async () => {
      try {
        const extracted = input.ctx.importChrome();
        if (!extracted) {
          throw new Error(
            "Could not extract tokens from Chrome. Open Slack in Chrome and ensure you're logged in.",
          );
        }

        await upsertWorkspaces(
          extracted.teams.map((team) => ({
            workspace_url: input.ctx.normalizeUrl(team.url),
            workspace_name: team.name,
            auth: {
              auth_type: "browser",
              xoxc_token: team.token,
              xoxd_cookie: extracted.cookie_d,
            },
          })),
        );
        console.log(`Imported ${extracted.teams.length} workspace token(s) from Chrome.`);
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  auth
    .command("import-brave")
    .description(
      "Import xoxc/xoxd from a logged-in Slack tab in Brave Browser (macOS). Requires View → Developer → Allow JavaScript from Apple Events to be enabled in Brave.",
    )
    .action(async () => {
      try {
        const extracted = await input.ctx.importBrave();
        if (!extracted) {
          throw new Error(
            "Could not extract tokens from Brave. Open Slack in Brave and ensure you're logged in. " +
              "If Brave is open with a Slack tab, also confirm View → Developer → Allow JavaScript from Apple Events is enabled.",
          );
        }

        await upsertWorkspaces(
          extracted.teams.map((team) => ({
            workspace_url: input.ctx.normalizeUrl(team.url),
            workspace_name: team.name,
            auth: {
              auth_type: "browser",
              xoxc_token: team.token,
              xoxd_cookie: extracted.cookie_d,
            },
          })),
        );
        console.log(`Imported ${extracted.teams.length} workspace token(s) from Brave.`);
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  auth
    .command("import-firefox")
    .description("Import xoxc/xoxd from Firefox profile storage (macOS/Linux)")
    .action(async () => {
      try {
        const extracted = await input.ctx.importFirefox();
        if (!extracted) {
          throw new Error(
            "Could not extract tokens from Firefox. Open Slack in Firefox and ensure you're logged in.",
          );
        }

        await upsertWorkspaces(
          extracted.teams.map((team) => ({
            workspace_url: input.ctx.normalizeUrl(team.url),
            workspace_name: team.name,
            auth: {
              auth_type: "browser",
              xoxc_token: team.token,
              xoxd_cookie: extracted.cookie_d,
            },
          })),
        );
        console.log(`Imported ${extracted.teams.length} workspace token(s) from Firefox.`);
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  auth
    .command("parse-curl")
    .description("Paste a Slack API request copied as cURL (extracts xoxc/xoxd and saves locally)")
    .action(async () => {
      try {
        const curlInput = await new Response(process.stdin).text();
        if (!curlInput.trim()) {
          throw new Error("Expected cURL command on stdin");
        }
        const parsed = input.ctx.parseCurl(curlInput);
        await upsertWorkspace({
          workspace_url: input.ctx.normalizeUrl(parsed.workspace_url),
          auth: {
            auth_type: "browser",
            xoxc_token: parsed.xoxc_token,
            xoxd_cookie: parsed.xoxd_cookie,
          },
        });
        console.log(`Imported tokens for ${input.ctx.normalizeUrl(parsed.workspace_url)}.`);
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  auth
    .command("import-desktop")
    .description(
      "Import xoxc token(s) + d cookie from Slack Desktop data (TypeScript; no need to quit Slack)",
    )
    .action(async () => {
      try {
        const extracted = await input.ctx.importDesktop();
        await upsertWorkspaces(
          extracted.teams.map((team) => ({
            workspace_url: input.ctx.normalizeUrl(team.url),
            workspace_name: team.name,
            auth: {
              auth_type: "browser",
              xoxc_token: team.token,
              xoxd_cookie: extracted.cookie_d,
            },
          })),
        );
        const payload = {
          imported: extracted.teams.length,
          source: extracted.source,
          workspaces: extracted.teams.map((t) => ({
            workspace_url: input.ctx.normalizeUrl(t.url),
            workspace_name: t.name,
          })),
        };
        console.log(JSON.stringify(pruneEmpty(payload), null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  auth
    .command("add")
    .description("Add credentials (standard token or browser xoxc/xoxd)")
    .requiredOption("--workspace-url <url>", "Workspace URL like https://myteam.slack.com")
    .option("--token <token>", "Standard Slack token (xoxb/xoxp)")
    .option("--xoxc <token>", "Browser token (xoxc-...)")
    .option("--xoxd <cookie>", "Browser cookie d (xoxd-...)")
    .action(async (...args) => {
      const [options] = args as [
        { workspaceUrl: string; token?: string; xoxc?: string; xoxd?: string },
      ];
      try {
        const workspaceUrl = input.ctx.normalizeUrl(options.workspaceUrl);
        if (options.token) {
          await upsertWorkspace({
            workspace_url: workspaceUrl,
            auth: { auth_type: "standard", token: options.token },
          });
          console.log("Saved standard token.");
          return;
        }
        if (options.xoxc && options.xoxd) {
          await upsertWorkspace({
            workspace_url: workspaceUrl,
            auth: {
              auth_type: "browser",
              xoxc_token: options.xoxc,
              xoxd_cookie: options.xoxd,
            },
          });
          console.log("Saved browser tokens.");
          return;
        }
        throw new Error("Provide either --token or both --xoxc and --xoxd");
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  auth
    .command("set-default")
    .description("Set the default workspace URL")
    .argument("<workspace-url>", "Workspace URL like https://myteam.slack.com")
    .action(async (...args) => {
      const [workspaceUrl] = args as [string];
      try {
        await setDefaultWorkspace(workspaceUrl);
        console.log("Default workspace updated.");
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });

  auth
    .command("remove")
    .description("Remove a workspace from local config")
    .argument("<workspace-url>", "Workspace URL like https://myteam.slack.com")
    .action(async (...args) => {
      const [workspaceUrl] = args as [string];
      try {
        await removeWorkspace(workspaceUrl);
        console.log("Removed workspace.");
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}
