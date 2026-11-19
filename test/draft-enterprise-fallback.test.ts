import { describe, expect, test } from "bun:test";
import type { CliContext } from "../src/cli/context.ts";
import {
  createDraftAction,
  deleteDraftAction,
  listDraftsAction,
} from "../src/cli/message-draft-actions.ts";
import {
  isTeamRestrictedError,
  withEnterpriseFallback,
} from "../src/cli/slack-native-draft-endpoint.ts";
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

type Call = { client: "workspace" | "enterprise"; method: string; params: Record<string, unknown> };

/**
 * A Grid workspace whose drafts.* calls are rejected with team_is_restricted
 * on the workspace domain (the live Meraki failure), plus the organization
 * endpoint where the same calls succeed. Mirrors the real browser transport,
 * which throws the Slack error code as the Error message.
 */
function createGridContext(input?: { grid?: boolean }) {
  const grid = input?.grid !== false;
  const calls: Call[] = [];
  const draftRecord = {
    id: "Dr123",
    blocks: [],
    destinations: [{ channel_id: "C11111111" }],
    last_updated_ts: "1700000000.42",
  };
  const workspaceClient = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ client: "workspace", method, params });
      if (method === "auth.test") {
        return { ok: true, url: `${workspaceUrl}/`, team_id: "T12345678", user_id: "U12345678" };
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
      if (method.startsWith("drafts.")) {
        throw new Error("team_is_restricted");
      }
      return { ok: true };
    },
  } as unknown as SlackApiClient;
  const enterpriseClient = {
    api: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ client: "enterprise", method, params });
      if (method === "auth.test") {
        return { ok: true, team_id: "E12345678", user_id: "U12345678" };
      }
      if (method === "drafts.list") {
        return { ok: true, drafts: [draftRecord] };
      }
      if (method === "drafts.create") {
        return { ok: true, draft: { id: "DrNew", destinations: params.destinations } };
      }
      return { ok: true };
    },
  } as unknown as SlackApiClient;
  const ctx = {
    effectiveWorkspaceUrl: (flag?: string) => flag,
    assertWorkspaceSpecifiedForChannelNames: async () => {},
    withAutoRefresh: async <T>(input: {
      workspaceUrl: string | undefined;
      work: () => Promise<T>;
    }) => input.work(),
    getClientForWorkspace: async (selector?: string) =>
      selector === enterpriseUrl
        ? { client: enterpriseClient, auth: enterpriseAuth, workspace_url: enterpriseUrl }
        : { client: workspaceClient, auth: workspaceAuth, workspace_url: workspaceUrl },
  } as unknown as CliContext;
  return { calls, ctx, workspaceClient, enterpriseClient };
}

describe("draft Enterprise Grid fallback", () => {
  test("list retries through the organization endpoint and notes the substitution", async () => {
    const { calls, ctx } = createGridContext();

    const result = (await listDraftsAction({
      ctx,
      options: { workspace: workspaceUrl },
    })) as { ok: boolean; count: number; routed_via_workspace_url?: string };

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.routed_via_workspace_url).toBe(enterpriseUrl);
    expect(calls.filter((c) => c.method === "drafts.list")).toEqual([
      { client: "workspace", method: "drafts.list", params: expect.anything() },
      { client: "enterprise", method: "drafts.list", params: expect.anything() },
    ]);
  });

  test("delete retries through the organization endpoint", async () => {
    const { calls, ctx } = createGridContext();

    const result = await deleteDraftAction({
      ctx,
      draftId: "Dr123",
      options: { workspace: workspaceUrl, lastUpdatedTs: "1700000000.42" },
    });

    expect(result).toEqual({
      ok: true,
      draft_id: "Dr123",
      routed_via_workspace_url: enterpriseUrl,
    });
    const del = calls.find((c) => c.client === "enterprise" && c.method === "drafts.delete");
    expect(del?.params).toEqual({
      draft_id: "Dr123",
      client_last_updated_ts: "1700000000.4200000",
    });
  });

  test("create retries through the organization endpoint", async () => {
    const { calls, ctx } = createGridContext();

    const result = (await createDraftAction({
      ctx,
      targetInput: "C11111111",
      text: "hello",
      options: { workspace: workspaceUrl },
    })) as { ok: boolean; draft: { id: string }; routed_via_workspace_url?: string };

    expect(result.ok).toBe(true);
    expect(result.draft.id).toBe("DrNew");
    expect(result.routed_via_workspace_url).toBe(enterpriseUrl);
    expect(calls.some((c) => c.client === "enterprise" && c.method === "drafts.create")).toBe(true);
  });

  test("the original error surfaces unchanged when no organization endpoint exists", async () => {
    const { calls, ctx } = createGridContext({ grid: false });

    await expect(listDraftsAction({ ctx, options: { workspace: workspaceUrl } })).rejects.toThrow(
      "team_is_restricted",
    );
    expect(calls.some((c) => c.client === "enterprise")).toBe(false);
  });
});

describe("withEnterpriseFallback", () => {
  test("does not resolve an organization endpoint for other errors or on success", async () => {
    const { calls, ctx, workspaceClient } = createGridContext();

    await expect(
      withEnterpriseFallback({
        getClientForWorkspace: ctx.getClientForWorkspace,
        client: workspaceClient,
        auth: workspaceAuth,
        workspaceUrl,
        work: async () => {
          throw new Error("invalid_auth");
        },
      }),
    ).rejects.toThrow("invalid_auth");

    const ok = await withEnterpriseFallback({
      getClientForWorkspace: ctx.getClientForWorkspace,
      client: workspaceClient,
      auth: workspaceAuth,
      workspaceUrl,
      work: async () => 42,
    });
    expect(ok).toEqual({ result: 42 });
    expect(calls.some((c) => c.method === "auth.test")).toBe(false);
  });
});

describe("isTeamRestrictedError", () => {
  test("matches the bare browser error and the wrapped platform error", () => {
    expect(isTeamRestrictedError(new Error("team_is_restricted"))).toBe(true);
    expect(
      isTeamRestrictedError(
        Object.assign(new Error("An API error occurred: team_is_restricted"), {
          data: { error: "team_is_restricted" },
        }),
      ),
    ).toBe(true);
    expect(isTeamRestrictedError(new Error("invalid_auth"))).toBe(false);
    expect(isTeamRestrictedError("team_is_restricted")).toBe(true);
    expect(isTeamRestrictedError(undefined)).toBe(false);
  });
});
