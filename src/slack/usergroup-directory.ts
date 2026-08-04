import { isRecord } from "../lib/object-type-guards.ts";
import type { SlackApiClient } from "./client.ts";
import { makeStrictUserOutputInert } from "./strict-user-resolution.ts";

const USERGROUP_ID_PATTERN = /^S[A-Z0-9]{8,}$/;
const USERGROUP_HANDLE_PATTERN = /^[A-Za-z0-9._-]+$/;

export type UserGroupDirectoryReason =
  | "usergroups_invalid"
  | "usergroup_invalid"
  | "usergroup_conflict"
  | "invalid_auth"
  | "token_expired"
  | "missing_scope"
  | "request_timeout"
  | "rate_limited"
  | "request_failed";

export type UserGroupMatchPath = "input.id->slack.id" | "input.handle->slack.handle";

export type ParsedUserGroupIdentity = {
  source: string;
  matches: {
    field: "id" | "handle";
    value: string;
    path: UserGroupMatchPath;
  }[];
};

export type DirectoryUserGroup = {
  id: string;
  handle: string;
  name?: string;
  dateDelete: number;
};

export type DirectoryComplete = {
  status: "complete";
  groups: number;
};

export type DirectoryIncomplete = {
  status: "incomplete";
  reason: UserGroupDirectoryReason;
};

export type LoadedDirectory =
  | { complete: true; directory: DirectoryComplete; groups: DirectoryUserGroup[] }
  | { complete: false; directory: DirectoryIncomplete };

export class UserGroupDirectoryRequestError extends Error {
  readonly reason: UserGroupDirectoryReason;

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "UserGroupDirectoryRequestError";
    this.reason = requestFailureReason(this.message);
  }
}

export async function loadUserGroupDirectory(client: SlackApiClient): Promise<LoadedDirectory> {
  let response: Record<string, unknown>;
  try {
    response = await client.api("usergroups.list", {
      include_disabled: true,
      include_count: false,
      include_users: false,
    });
  } catch (error) {
    throw new UserGroupDirectoryRequestError(error);
  }

  if (!Array.isArray(response.usergroups)) {
    return incompleteDirectory("usergroups_invalid");
  }

  const groups = new Map<string, DirectoryUserGroup>();
  for (const rawGroup of response.usergroups) {
    if (!isRecord(rawGroup) || Array.isArray(rawGroup)) {
      return incompleteDirectory("usergroups_invalid");
    }
    const parsed = parseDirectoryUserGroup(rawGroup);
    if (!parsed) {
      return incompleteDirectory("usergroup_invalid");
    }
    const existing = groups.get(parsed.id);
    if (!existing) {
      groups.set(parsed.id, parsed);
      continue;
    }
    if (!sameDirectoryUserGroup(existing, parsed)) {
      return incompleteDirectory("usergroup_conflict");
    }
  }

  return {
    complete: true,
    directory: { status: "complete", groups: groups.size },
    groups: [...groups.values()],
  };
}

export function parseUserGroupIdentity(input: string): ParsedUserGroupIdentity {
  const compact = input.trim();
  if (!compact) {
    throw new Error("User-group identity is empty");
  }
  const source = makeStrictUserOutputInert(compact);
  if (USERGROUP_ID_PATTERN.test(compact)) {
    return {
      source,
      matches: [
        { field: "id", value: compact, path: "input.id->slack.id" },
        {
          field: "handle",
          value: compact.toLowerCase(),
          path: "input.handle->slack.handle",
        },
      ],
    };
  }

  const handle = compact.startsWith("@") ? compact.slice(1) : compact;
  if (!handle || !USERGROUP_HANDLE_PATTERN.test(handle)) {
    throw new Error(
      "User-group handles must contain only letters, numbers, dots, underscores, or hyphens",
    );
  }
  return {
    source,
    matches: [
      {
        field: "handle",
        value: handle.toLowerCase(),
        path: "input.handle->slack.handle",
      },
    ],
  };
}

export function findUserGroupMatches(
  groups: DirectoryUserGroup[],
  identity: ParsedUserGroupIdentity,
): { group: DirectoryUserGroup; matchedBy: [UserGroupMatchPath, ...UserGroupMatchPath[]] }[] {
  return groups.flatMap((group) => {
    const matchedBy = identity.matches
      .filter(({ field, value }) => group[field].toLowerCase() === value.toLowerCase())
      .map(({ path }) => path);
    if (matchedBy.length === 0) {
      return [];
    }
    return [
      {
        group,
        matchedBy: matchedBy as [UserGroupMatchPath, ...UserGroupMatchPath[]],
      },
    ];
  });
}

function parseDirectoryUserGroup(raw: Record<string, unknown>): DirectoryUserGroup | null {
  if (raw.is_usergroup !== true) {
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  const handle = typeof raw.handle === "string" ? raw.handle : "";
  const name = raw.name === undefined || raw.name === null ? undefined : raw.name;
  const dateDelete = raw.date_delete;
  if (
    !USERGROUP_ID_PATTERN.test(id) ||
    !USERGROUP_HANDLE_PATTERN.test(handle) ||
    (name !== undefined && typeof name !== "string") ||
    typeof dateDelete !== "number" ||
    !Number.isSafeInteger(dateDelete) ||
    dateDelete < 0
  ) {
    return null;
  }
  return {
    id,
    handle: handle.toLowerCase(),
    name: name ? makeStrictUserOutputInert(name.trim()) : undefined,
    dateDelete,
  };
}

function sameDirectoryUserGroup(left: DirectoryUserGroup, right: DirectoryUserGroup): boolean {
  return (
    left.id === right.id &&
    left.handle === right.handle &&
    left.name === right.name &&
    left.dateDelete === right.dateDelete
  );
}

function incompleteDirectory(reason: UserGroupDirectoryReason): LoadedDirectory {
  return { complete: false, directory: { status: "incomplete", reason } };
}

function requestFailureReason(message: string): UserGroupDirectoryReason {
  if (/(?:^|[^a-z])invalid_auth(?:$|[^a-z])/i.test(message)) {
    return "invalid_auth";
  }
  if (/(?:^|[^a-z])token_expired(?:$|[^a-z])/i.test(message)) {
    return "token_expired";
  }
  if (/(?:^|[^a-z])missing_scope(?:$|[^a-z])/i.test(message)) {
    return "missing_scope";
  }
  if (/timed out|timeout/i.test(message)) {
    return "request_timeout";
  }
  if (/rate[-_ ]?limit(?:ed)?/i.test(message)) {
    return "rate_limited";
  }
  return "request_failed";
}
