import type { SlackApiClient } from "./client.ts";
import {
  findUserGroupMatches,
  loadUserGroupDirectory,
  parseUserGroupIdentity,
  type DirectoryComplete,
  type DirectoryIncomplete,
  type UserGroupDirectoryReason,
  UserGroupDirectoryRequestError,
  type UserGroupMatchPath,
} from "./usergroup-directory.ts";

export { type UserGroupDirectoryReason, UserGroupDirectoryRequestError };

type ResolvedEvidence = {
  source: string;
  status: "resolved";
  matched_by: [UserGroupMatchPath, ...UserGroupMatchPath[]];
};

type UnsafeResolutionResult =
  | ResolvedEvidence
  | { source: string; status: "inactive" | "ambiguous"; candidate_count: number }
  | { source: string; status: "not_found"; candidate_count: 0 };

export type StrictUserGroupResolution =
  | {
      directory: DirectoryComplete;
      safe_to_mention: true;
      results: (ResolvedEvidence & { mention: `<!subteam^${string}>` })[];
    }
  | {
      directory: DirectoryComplete;
      safe_to_mention: false;
      results: UnsafeResolutionResult[];
    }
  | {
      directory: DirectoryIncomplete;
      safe_to_mention: false;
      results: [];
    };

export type UserGroupLookup =
  | {
      directory: DirectoryComplete;
      result: {
        source: string;
        status: "active" | "inactive";
        group: { id: string; handle: string; name?: string };
      };
    }
  | {
      directory: DirectoryComplete;
      result:
        | { source: string; status: "not_found"; candidate_count: 0 }
        | { source: string; status: "ambiguous"; candidate_count: number };
    }
  | {
      directory: DirectoryIncomplete;
    };

export async function getExactUserGroup(input: {
  client: SlackApiClient;
  identity: string;
}): Promise<UserGroupLookup> {
  const identity = parseUserGroupIdentity(input.identity);
  const loaded = await loadUserGroupDirectory(input.client);
  if (!loaded.complete) {
    return { directory: loaded.directory };
  }

  const matches = findUserGroupMatches(loaded.groups, identity);
  if (matches.length === 0) {
    return {
      directory: loaded.directory,
      result: { source: identity.source, status: "not_found", candidate_count: 0 },
    };
  }
  if (matches.length > 1) {
    return {
      directory: loaded.directory,
      result: {
        source: identity.source,
        status: "ambiguous",
        candidate_count: matches.length,
      },
    };
  }

  const { group } = matches[0]!;
  return {
    directory: loaded.directory,
    result: {
      source: identity.source,
      status: group.dateDelete === 0 ? "active" : "inactive",
      group: {
        id: group.id,
        handle: group.handle,
        name: group.name,
      },
    },
  };
}

export async function resolveStrictUserGroups(input: {
  client: SlackApiClient;
  identities: string[];
}): Promise<StrictUserGroupResolution> {
  if (input.identities.length === 0) {
    throw new Error("At least one user-group identity is required");
  }

  const identities = input.identities.map(parseUserGroupIdentity);
  const loaded = await loadUserGroupDirectory(input.client);
  if (!loaded.complete) {
    return incompleteUserGroupResolution(loaded.directory.reason);
  }

  const evaluated = identities.map((identity) => {
    const matches = findUserGroupMatches(loaded.groups, identity);
    const active = matches.filter(({ group }) => group.dateDelete === 0);
    const inactiveCanonicalId = matches.find(
      ({ group, matchedBy }) => group.dateDelete !== 0 && matchedBy.includes("input.id->slack.id"),
    );
    if (inactiveCanonicalId && active.length > 0) {
      return {
        source: identity.source,
        status: "ambiguous" as const,
        candidate_count: active.length + 1,
      };
    }
    if (active.length === 0) {
      if (matches.length > 0) {
        return {
          source: identity.source,
          status: "inactive" as const,
          candidate_count: matches.length,
        };
      }
      return {
        source: identity.source,
        status: "not_found" as const,
        candidate_count: 0 as const,
      };
    }
    if (active.length > 1) {
      return {
        source: identity.source,
        status: "ambiguous" as const,
        candidate_count: active.length,
      };
    }
    return {
      source: identity.source,
      status: "resolved" as const,
      matched_by: active[0]!.matchedBy,
      groupId: active[0]!.group.id,
    };
  });

  const allResolved = evaluated.every(
    (result): result is ResolvedEvidence & { groupId: string } => result.status === "resolved",
  );
  if (allResolved) {
    return {
      directory: loaded.directory,
      safe_to_mention: true,
      results: evaluated.map(({ groupId, ...result }) => ({
        ...result,
        mention: `<!subteam^${groupId}>`,
      })),
    };
  }

  return {
    directory: loaded.directory,
    safe_to_mention: false,
    results: evaluated.map((result) => {
      if (result.status !== "resolved") {
        return result;
      }
      const { groupId: _groupId, ...withoutGroupId } = result;
      return withoutGroupId;
    }),
  };
}

export function incompleteUserGroupResolution(
  reason: UserGroupDirectoryReason,
): StrictUserGroupResolution {
  return {
    directory: { status: "incomplete", reason },
    safe_to_mention: false,
    results: [],
  };
}

export function incompleteUserGroupLookup(reason: UserGroupDirectoryReason): UserGroupLookup {
  return { directory: { status: "incomplete", reason } };
}
