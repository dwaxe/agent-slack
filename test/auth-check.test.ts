import { describe, expect, test } from "bun:test";
import type { CliContext } from "../src/cli/context.ts";
import { handleAuthCheck } from "../src/cli/auth-command.ts";

function buildContext(authenticatedUrl = "https://workspace.slack.com/"): CliContext {
  return {
    effectiveWorkspaceUrl: (workspace?: string) => workspace,
    normalizeUrl: (url: string) => new URL(url).origin,
    withAutoRefresh: async (input: { work: () => Promise<unknown> }) => await input.work(),
    getClientForWorkspace: async () => ({
      workspace_url: "https://workspace.slack.com",
      auth: { auth_type: "browser", xoxc_token: "test", xoxd_cookie: "test" },
      client: {
        api: async () => ({
          ok: true,
          team_id: "T12345678",
          user_id: "U12345678",
          url: authenticatedUrl,
        }),
      },
    }),
  } as unknown as CliContext;
}

describe("compact authentication check", () => {
  test("returns only stable readiness fields", async () => {
    await expect(handleAuthCheck({ ctx: buildContext(), workspace: "workspace" })).resolves.toEqual(
      {
        ok: true,
        workspace_url: "https://workspace.slack.com",
        team_id: "T12345678",
        user_id: "U12345678",
        auth_type: "browser",
      },
    );
  });

  test("rejects credentials that authenticate to another workspace", async () => {
    await expect(
      handleAuthCheck({
        ctx: buildContext("https://other.slack.com/"),
        workspace: "workspace",
      }),
    ).rejects.toThrow("different workspace");
  });
});
