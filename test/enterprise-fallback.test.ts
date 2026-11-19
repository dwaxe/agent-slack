import { describe, expect, test } from "bun:test";
import type { CliContext } from "../src/cli/context.ts";
import { attachEnterpriseFallback } from "../src/cli/slack-native-draft-endpoint.ts";
import type { SlackApiClient, SlackAuth } from "../src/slack/client.ts";

const workspaceUrl = "https://workspace.slack.com";
const enterpriseUrl = "https://grid.enterprise.slack.com";
const workspaceAuth: SlackAuth = {
  auth_type: "browser",
  xoxc_token: "xoxc-test",
  xoxd_cookie: "xoxd-test",
};
const enterpriseAuth: SlackAuth = {
  auth_type: "browser",
  xoxc_token: "xoxc-enterprise-test",
  xoxd_cookie: "xoxd-test",
};
const standardAuth: SlackAuth = { auth_type: "standard", token: "xoxb-test" };

type Call = { client: "workspace" | "enterprise"; method: string };

/**
 * A Grid workspace whose domain-addressed calls are rejected with
 * team_is_restricted (the live Meraki failure), plus the organization
 * endpoint where the same calls succeed. The clients are plain fakes at the
 * SlackApiClient interface, mirroring test/draft-enterprise-fallback.test.ts.
 */
function createGridClients(input?: {
  grid?: boolean;
  restrictedOnEnterprise?: boolean;
  workspaceError?: string;
}) {
  const grid = input?.grid !== false;
  const calls: Call[] = [];
  const makeApi =
    (client: "workspace" | "enterprise") =>
    async (method: string): Promise<Record<string, unknown>> => {
      calls.push({ client, method });
      if (method === "auth.test") {
        return client === "workspace"
          ? { ok: true, url: `${workspaceUrl}/`, team_id: "T12345678", user_id: "U12345678" }
          : { ok: true, team_id: "E12345678", user_id: "U12345678" };
      }
      if (method === "team.info") {
        return {
          ok: true,
          team: {
            id: "T12345678",
            ...(grid ? { enterprise_id: "E12345678", enterprise_domain: "grid" } : {}),
          },
        };
      }
      if (client === "workspace") {
        throw new Error(input?.workspaceError ?? "team_is_restricted");
      }
      if (input?.restrictedOnEnterprise) {
        throw new Error("team_is_restricted");
      }
      return { ok: true, via: "enterprise" };
    };
  const workspaceApi = makeApi("workspace");
  const enterpriseApi = makeApi("enterprise");
  const workspaceClient = {
    api: workspaceApi,
    apiMultipart: workspaceApi,
  } as unknown as SlackApiClient;
  const enterpriseClient = {
    api: enterpriseApi,
    apiMultipart: enterpriseApi,
  } as unknown as SlackApiClient;
  const getClientForWorkspace = (async (selector?: string) =>
    selector === enterpriseUrl
      ? { client: enterpriseClient, auth: enterpriseAuth, workspace_url: enterpriseUrl }
      : {
          client: workspaceClient,
          auth: workspaceAuth,
          workspace_url: workspaceUrl,
        }) as unknown as CliContext["getClientForWorkspace"];
  return { calls, workspaceClient, enterpriseClient, getClientForWorkspace };
}

describe("attachEnterpriseFallback", () => {
  test("a non-draft call refused with team_is_restricted retries via the organization endpoint and notes it", async () => {
    const { calls, workspaceClient, getClientForWorkspace } = createGridClients();
    const client = attachEnterpriseFallback({
      getClientForWorkspace,
      client: workspaceClient,
      auth: workspaceAuth,
      workspaceUrl,
    });

    const result = await client.api("conversations.list", { limit: 5 });

    expect(result).toEqual({ ok: true, via: "enterprise" });
    expect(client.routedViaWorkspaceUrl).toBe(enterpriseUrl);
    expect(calls.filter((c) => c.method === "conversations.list")).toEqual([
      { client: "workspace", method: "conversations.list" },
      { client: "enterprise", method: "conversations.list" },
    ]);
  });

  test("a successful call never resolves an organization endpoint", async () => {
    const { calls, enterpriseClient, getClientForWorkspace } = createGridClients();
    // Attach to the enterprise client, whose calls succeed.
    const client = attachEnterpriseFallback({
      getClientForWorkspace,
      client: enterpriseClient,
      auth: enterpriseAuth,
      workspaceUrl: enterpriseUrl,
    });

    const result = await client.api("conversations.list", {});

    expect(result).toEqual({ ok: true, via: "enterprise" });
    expect(client.routedViaWorkspaceUrl).toBeUndefined();
    expect(calls.some((c) => c.method === "auth.test" || c.method === "team.info")).toBe(false);
  });

  test("a different error never retries", async () => {
    const { calls, workspaceClient, getClientForWorkspace } = createGridClients({
      workspaceError: "invalid_auth",
    });
    const client = attachEnterpriseFallback({
      getClientForWorkspace,
      client: workspaceClient,
      auth: workspaceAuth,
      workspaceUrl,
    });

    await expect(client.api("conversations.list", {})).rejects.toThrow("invalid_auth");
    expect(calls.filter((c) => c.method === "conversations.list")).toEqual([
      { client: "workspace", method: "conversations.list" },
    ]);
    expect(calls.some((c) => c.method === "auth.test")).toBe(false);
    expect(client.routedViaWorkspaceUrl).toBeUndefined();
  });

  test("the original error surfaces unchanged when no organization endpoint exists", async () => {
    const { calls, workspaceClient, getClientForWorkspace } = createGridClients({ grid: false });
    const client = attachEnterpriseFallback({
      getClientForWorkspace,
      client: workspaceClient,
      auth: workspaceAuth,
      workspaceUrl,
    });

    await expect(client.api("conversations.list", {})).rejects.toThrow("team_is_restricted");
    expect(calls.some((c) => c.client === "enterprise")).toBe(false);
    expect(client.routedViaWorkspaceUrl).toBeUndefined();
  });

  test("retries only once when the organization endpoint is also restricted", async () => {
    const { calls, workspaceClient, getClientForWorkspace } = createGridClients({
      restrictedOnEnterprise: true,
    });
    const client = attachEnterpriseFallback({
      getClientForWorkspace,
      client: workspaceClient,
      auth: workspaceAuth,
      workspaceUrl,
    });

    await expect(client.api("conversations.list", {})).rejects.toThrow("team_is_restricted");
    expect(
      calls.filter((c) => c.client === "enterprise" && c.method === "conversations.list"),
    ).toHaveLength(1);
    expect(client.routedViaWorkspaceUrl).toBeUndefined();
  });

  test("never falls back when already on the enterprise domain", async () => {
    const { calls, enterpriseClient, getClientForWorkspace } = createGridClients({
      restrictedOnEnterprise: true,
    });
    const client = attachEnterpriseFallback({
      getClientForWorkspace,
      client: enterpriseClient,
      auth: enterpriseAuth,
      workspaceUrl: enterpriseUrl,
    });

    await expect(client.api("conversations.list", {})).rejects.toThrow("team_is_restricted");
    expect(calls.filter((c) => c.method === "conversations.list")).toHaveLength(1);
    expect(calls.some((c) => c.method === "team.info")).toBe(false);
  });

  test("never falls back for standard auth", async () => {
    const { calls, workspaceClient, getClientForWorkspace } = createGridClients();
    const client = attachEnterpriseFallback({
      getClientForWorkspace,
      client: workspaceClient,
      auth: standardAuth,
      workspaceUrl,
    });

    await expect(client.api("conversations.list", {})).rejects.toThrow("team_is_restricted");
    expect(calls.filter((c) => c.method === "conversations.list")).toHaveLength(1);
    expect(calls.some((c) => c.method === "auth.test")).toBe(false);
  });
});
