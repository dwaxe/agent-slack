import { describe, expect, test } from "bun:test";
import {
  getExactUserGroup,
  resolveStrictUserGroups,
  type UserGroupDirectoryReason,
  UserGroupDirectoryRequestError,
} from "../src/slack/usergroups.ts";

function group(
  ...args: [id: string, handle: string, overrides?: Record<string, unknown>]
): Record<string, unknown> {
  const [id, handle, overrides = {}] = args;
  return {
    id,
    handle,
    name: `${handle} name`,
    is_usergroup: true,
    date_delete: 0,
    ...overrides,
  };
}

function client(
  response: Record<string, unknown> | Error,
  calls: { method: string; params: Record<string, unknown> }[] = [],
) {
  return {
    api: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
  } as never;
}

describe("strict user-group resolution", () => {
  test("resolves an exact batch atomically from one complete snapshot", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const result = await resolveStrictUserGroups({
      client: client(
        {
          usergroups: [group("S11111111", "cloud-team"), group("S22222222", "security-team")],
        },
        calls,
      ),
      identities: ["@CLOUD-TEAM", "S22222222"],
    });

    expect(calls).toEqual([
      {
        method: "usergroups.list",
        params: {
          include_disabled: true,
          include_count: false,
          include_users: false,
        },
      },
    ]);
    expect(result).toMatchObject({
      directory: { status: "complete", groups: 2 },
      safe_to_mention: true,
      results: [
        {
          source: "@CLOUD-TEAM",
          status: "resolved",
          matched_by: ["input.handle->slack.handle"],
          mention: "<!subteam^S11111111>",
        },
        {
          source: "S22222222",
          status: "resolved",
          matched_by: ["input.id->slack.id"],
          mention: "<!subteam^S22222222>",
        },
      ],
    });
  });

  test("suppresses every mention when a batch contains an inactive group", async () => {
    const result = await resolveStrictUserGroups({
      client: client({
        usergroups: [
          group("S11111111", "active"),
          group("S22222222", "retired", { date_delete: 123 }),
        ],
      }),
      identities: ["@active", "@retired"],
    });

    expect(result.safe_to_mention).toBe(false);
    expect(result.results).toEqual([
      {
        source: "@active",
        status: "resolved",
        matched_by: ["input.handle->slack.handle"],
      },
      { source: "@retired", status: "inactive", candidate_count: 1 },
    ]);
    expect(JSON.stringify(result)).not.toContain("<!subteam^");
    expect(JSON.stringify(result)).not.toContain("S11111111");
  });

  test("prefers one active group over disabled groups with the same handle", async () => {
    const result = await resolveStrictUserGroups({
      client: client({
        usergroups: [group("S11111111", "team", { date_delete: 123 }), group("S22222222", "team")],
      }),
      identities: ["team"],
    });

    expect(result.safe_to_mention).toBe(true);
    expect(JSON.stringify(result)).toContain("<!subteam^S22222222>");
  });

  test("treats a bare lowercase handle beginning with s as a handle", async () => {
    const result = await resolveStrictUserGroups({
      client: client({ usergroups: [group("S11111111", "supportteam")] }),
      identities: ["supportteam"],
    });

    expect(result.safe_to_mention).toBe(true);
    expect(result.results[0]).toMatchObject({
      matched_by: ["input.handle->slack.handle"],
      mention: "<!subteam^S11111111>",
    });
  });

  test("treats an ID-shaped bare value as both an ID and a handle", async () => {
    const byHandle = await resolveStrictUserGroups({
      client: client({ usergroups: [group("S11111111", "supportteam")] }),
      identities: ["SUPPORTTEAM"],
    });
    expect(byHandle.safe_to_mention).toBe(true);
    expect(byHandle.results[0]).toMatchObject({
      matched_by: ["input.handle->slack.handle"],
      mention: "<!subteam^S11111111>",
    });

    const ambiguous = await resolveStrictUserGroups({
      client: client({
        usergroups: [group("S22222222", "other"), group("S33333333", "s22222222")],
      }),
      identities: ["S22222222"],
    });
    expect(ambiguous).toMatchObject({
      safe_to_mention: false,
      results: [{ status: "ambiguous", candidate_count: 2 }],
    });
    expect(JSON.stringify(ambiguous)).not.toContain("<!subteam^");
  });

  test("does not redirect an inactive canonical ID to an active matching handle", async () => {
    const result = await resolveStrictUserGroups({
      client: client({
        usergroups: [
          group("S22222222", "retired", { date_delete: 123 }),
          group("S33333333", "s22222222"),
        ],
      }),
      identities: ["S22222222"],
    });

    expect(result).toMatchObject({
      safe_to_mention: false,
      results: [{ status: "ambiguous", candidate_count: 2 }],
    });
    expect(JSON.stringify(result)).not.toContain("<!subteam^");
    expect(JSON.stringify(result)).not.toContain("S33333333");
  });

  test("reports ambiguity when multiple active groups have one exact handle", async () => {
    const result = await resolveStrictUserGroups({
      client: client({
        usergroups: [group("S11111111", "team"), group("S22222222", "team")],
      }),
      identities: ["@team"],
    });

    expect(result).toMatchObject({
      safe_to_mention: false,
      results: [{ status: "ambiguous", candidate_count: 2 }],
    });
    expect(JSON.stringify(result)).not.toContain("<!subteam^");
  });

  test("fails closed for malformed or conflicting directory evidence", async () => {
    const cases: [string, Record<string, unknown>, UserGroupDirectoryReason][] = [
      ["missing list", {}, "usergroups_invalid"],
      ["non-object entry", { usergroups: ["bad"] }, "usergroups_invalid"],
      ["invalid id", { usergroups: [group("not-an-id", "team")] }, "usergroup_invalid"],
      ["invalid handle", { usergroups: [group("S11111111", "bad handle")] }, "usergroup_invalid"],
      [
        "unknown lifecycle",
        { usergroups: [group("S11111111", "team", { date_delete: undefined })] },
        "usergroup_invalid",
      ],
      [
        "conflicting duplicate",
        {
          usergroups: [group("S11111111", "team"), group("S11111111", "other-team")],
        },
        "usergroup_conflict",
      ],
    ];

    for (const [name, response, reason] of cases) {
      const result = await resolveStrictUserGroups({
        client: client(response),
        identities: ["@team"],
      });
      expect(result, name).toEqual({
        directory: { status: "incomplete", reason },
        safe_to_mention: false,
        results: [],
      });
    }
  });

  test("classifies terminal request failures without exposing provisional results", async () => {
    try {
      await resolveStrictUserGroups({
        client: client(new Error("Slack API usergroups.list missing_scope")),
        identities: ["@team"],
      });
      throw new Error("expected request failure");
    } catch (error) {
      expect(error).toBeInstanceOf(UserGroupDirectoryRequestError);
      expect((error as UserGroupDirectoryRequestError).reason).toBe("missing_scope");
    }
  });

  test("makes notification-shaped echoed input inert", async () => {
    const result = await resolveStrictUserGroups({
      client: client({ usergroups: [] }),
      identities: ["@here"],
    });
    const output = JSON.stringify(result);

    expect(output).not.toContain("@here");
    expect(output).not.toContain("<!");
    expect(output).toContain("＠here");
  });

  test("rejects malformed handles before calling Slack", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    await expect(
      resolveStrictUserGroups({
        client: client({ usergroups: [] }, calls),
        identities: ["bad handle"],
      }),
    ).rejects.toThrow("User-group handles");
    expect(calls).toHaveLength(0);
  });
});

describe("exact user-group lookup", () => {
  test("returns compact inactive metadata without a mention", async () => {
    const result = await getExactUserGroup({
      client: client({
        usergroups: [
          group("S11111111", "Cloud-Team", {
            date_delete: 123,
            name: "Cloud <@U99999999> @here",
          }),
        ],
      }),
      identity: "@cloud-team",
    });

    expect(result).toMatchObject({
      directory: { status: "complete", groups: 1 },
      result: {
        status: "inactive",
        group: { id: "S11111111", handle: "cloud-team" },
      },
    });
    const output = JSON.stringify(result);
    expect(output).not.toContain("<!subteam^");
    expect(output).not.toContain("<@");
    expect(output).not.toContain("@here");
  });
});
