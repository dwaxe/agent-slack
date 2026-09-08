import { describe, expect, test } from "bun:test";
import type { CliContext } from "../src/cli/context.ts";
import { resolveSlackNativeDraftEndpoint } from "../src/cli/slack-native-draft-endpoint.ts";
import type { SlackApiClient, SlackAuth } from "../src/slack/client.ts";

const workspaceUrl = "https://workspace.slack.com";
const enterpriseUrl = "https://grid.enterprise.slack.com";
const browserAuth: SlackAuth = {
  auth_type: "browser",
  xoxc_token: "xoxc-test",
  xoxd_cookie: "xoxd-test",
};

function createGridFixture(input?: {
  enterpriseUserId?: string;
  enterpriseTeamId?: string;
  identityUrl?: string;
}) {
  const calls: { client: "workspace" | "enterprise"; method: string }[] = [];
  const api =
    (client: "workspace" | "enterprise") =>
    async (method: string): Promise<Record<string, unknown>> => {
      calls.push({ client, method });
      if (method === "auth.test") {
        return client === "workspace"
          ? {
              ok: true,
              url: input?.identityUrl ?? `${workspaceUrl}/`,
              team_id: "T12345678",
              user_id: "U12345678",
            }
          : {
              ok: true,
              team_id: input?.enterpriseTeamId ?? "E12345678",
              user_id: input?.enterpriseUserId ?? "U12345678",
            };
      }
      if (method === "team.info") {
        return {
          ok: true,
          team: {
            id: "T12345678",
            enterprise_id: "E12345678",
            enterprise_domain: "grid",
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    };
  const workspaceClient = { api: api("workspace") } as SlackApiClient;
  const enterpriseClient = { api: api("enterprise") } as SlackApiClient;
  const ctx = {
    getClientForWorkspace: async (selector?: string) => {
      expect(selector).toBe(enterpriseUrl);
      return { client: enterpriseClient, auth: browserAuth, workspace_url: enterpriseUrl };
    },
  } as CliContext;
  return { calls, ctx, workspaceClient, enterpriseClient };
}

describe("resolveSlackNativeDraftEndpoint", () => {
  test("routes a child workspace through its verified Enterprise Grid organization", async () => {
    const fixture = createGridFixture();

    const endpoint = await resolveSlackNativeDraftEndpoint({
      ctx: fixture.ctx,
      client: fixture.workspaceClient,
      auth: browserAuth,
      workspaceUrl,
    });

    expect(endpoint.client).toBe(fixture.enterpriseClient);
    expect(endpoint.workspaceUrl).toBe(enterpriseUrl);
    expect(fixture.calls).toEqual([
      { client: "workspace", method: "auth.test" },
      { client: "workspace", method: "team.info" },
      { client: "enterprise", method: "auth.test" },
    ]);
  });

  test("rejects organization credentials for a different enterprise or user", async () => {
    const wrongEnterprise = createGridFixture({ enterpriseTeamId: "E99999999" });
    await expect(
      resolveSlackNativeDraftEndpoint({
        ctx: wrongEnterprise.ctx,
        client: wrongEnterprise.workspaceClient,
        auth: browserAuth,
        workspaceUrl,
      }),
    ).rejects.toThrow("do not match the target workspace's organization");

    const wrongUser = createGridFixture({ enterpriseUserId: "U99999999" });
    await expect(
      resolveSlackNativeDraftEndpoint({
        ctx: wrongUser.ctx,
        client: wrongUser.workspaceClient,
        auth: browserAuth,
        workspaceUrl,
      }),
    ).rejects.toThrow("do not belong to the same Slack user");
  });

  test("rejects credentials authenticated to a different workspace", async () => {
    const fixture = createGridFixture({ identityUrl: "https://other.slack.com/" });

    await expect(
      resolveSlackNativeDraftEndpoint({
        ctx: fixture.ctx,
        client: fixture.workspaceClient,
        auth: browserAuth,
        workspaceUrl,
      }),
    ).rejects.toThrow("workspace origin does not match");
    expect(fixture.calls).toEqual([{ client: "workspace", method: "auth.test" }]);
  });

  test("keeps standard auth and organization URLs on their selected endpoint", async () => {
    const fixture = createGridFixture();
    const standardAuth = { auth_type: "standard" as const, token: "xoxb-test" };

    const standard = await resolveSlackNativeDraftEndpoint({
      ctx: fixture.ctx,
      client: fixture.workspaceClient,
      auth: standardAuth,
      workspaceUrl,
    });
    const organization = await resolveSlackNativeDraftEndpoint({
      ctx: fixture.ctx,
      client: fixture.enterpriseClient,
      auth: browserAuth,
      workspaceUrl: enterpriseUrl,
    });

    expect(standard.client).toBe(fixture.workspaceClient);
    expect(organization.client).toBe(fixture.enterpriseClient);
    expect(fixture.calls).toHaveLength(0);
  });
});
