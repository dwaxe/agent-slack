import { isRecord } from "../lib/object-type-guards.ts";
import type { SlackApiClient } from "./client.ts";
import { makeStrictUserOutputInert } from "./strict-user-resolution-evidence.ts";
import { isUserId } from "./user-id.ts";

export { makeStrictUserOutputInert } from "./strict-user-resolution-evidence.ts";

export type StrictUserMatchPath = "input.id->slack.id" | "input.email->slack.emailLookup";

export type StrictUserResolutionReason =
  | "invalid_auth"
  | "token_expired"
  | "request_timeout"
  | "rate_limited"
  | "request_failed";

type Identity =
  | { kind: "id"; value: string; key: string; source: string; matchedBy: StrictUserMatchPath }
  | { kind: "email"; value: string; key: string; source: string; matchedBy: StrictUserMatchPath };

type StrictResolvedEvidence = {
  source: string;
  status: "resolved";
  matched_by: StrictUserMatchPath[];
};

type StrictResolvedWithMention = StrictResolvedEvidence & {
  mention: `<@${string}>`;
};

type StrictResolvedWithoutMention = StrictResolvedEvidence & {
  mention?: never;
};

type StrictNotFound = {
  source: string;
  status: "not_found";
  candidate_count: 0;
  mention?: never;
};

type StrictAmbiguous = {
  source: string;
  status: "ambiguous";
  candidate_count: number;
  mention?: never;
};

export type StrictUserResolutionResult =
  | StrictResolvedWithMention
  | StrictResolvedWithoutMention
  | StrictNotFound
  | StrictAmbiguous;

export type StrictUserResolution =
  | {
      lookups: { status: "complete"; requests: number };
      safe_to_mention: true;
      results: StrictResolvedWithMention[];
    }
  | {
      lookups: { status: "complete"; requests: number };
      safe_to_mention: false;
      results: (StrictResolvedWithoutMention | StrictNotFound | StrictAmbiguous)[];
    }
  | {
      lookups: {
        status: "incomplete";
        requests: number;
        reason: StrictUserResolutionReason;
      };
      safe_to_mention: false;
      results: [];
    };

type EvaluatedResult =
  | (StrictResolvedEvidence & { userId: string })
  | StrictNotFound
  | StrictAmbiguous;

type LookupResult =
  | { status: "resolved"; matched_by: StrictUserMatchPath[]; userId: string }
  | { status: "not_found"; candidate_count: 0 }
  | { status: "ambiguous"; candidate_count: number };

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const MAX_USER_RESOLUTION_IDENTITIES = 20;

export class StrictUserLookupRequestError extends Error {
  readonly requests: number;
  readonly reason: StrictUserResolutionReason;

  constructor(error: unknown, requests: number) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "StrictUserLookupRequestError";
    this.requests = requests;
    this.reason = requestFailureReason(this.message);
  }
}

export function validateStrictUserIdentityBatch(identities: string[]): void {
  prepareIdentities(identities);
}

export async function resolveStrictUserIdentities(input: {
  client: SlackApiClient;
  identities: string[];
  edgeCacheId?: string;
}): Promise<StrictUserResolution> {
  const identities = prepareIdentities(input.identities);
  const uniqueIdentities = new Map<string, Identity>();
  for (const identity of identities) {
    uniqueIdentities.set(identity.key, identity);
  }

  const resultByIdentity = new Map<string, LookupResult>();
  let requests = 0;
  for (const identity of uniqueIdentities.values()) {
    let response: Record<string, unknown>;
    try {
      requests += 1;
      response =
        identity.kind === "id"
          ? await input.client.api("users.info", { user: identity.value })
          : await input.client.lookupUserByEmail(identity.value, input.edgeCacheId);
    } catch (error) {
      if (isNotFoundError(error, identity.kind)) {
        resultByIdentity.set(identity.key, { status: "not_found", candidate_count: 0 });
        continue;
      }
      throw new StrictUserLookupRequestError(error, requests);
    }

    let userId: string | null;
    if (identity.kind === "email" && Array.isArray(response.results)) {
      const candidates = parseExactEmailCandidates(response.results, identity.value);
      if (candidates.length !== 1) {
        resultByIdentity.set(
          identity.key,
          candidates.length === 0
            ? { status: "not_found", candidate_count: 0 }
            : { status: "ambiguous", candidate_count: candidates.length },
        );
        continue;
      }
      try {
        requests += 1;
        const verified = await input.client.api("users.info", { user: candidates[0] });
        userId = parseVerifiedUserId(verified.user);
      } catch (error) {
        throw new StrictUserLookupRequestError(error, requests);
      }
    } else {
      userId = parseVerifiedUserId(response.user);
    }
    if (typeof userId === "string" && (identity.kind === "email" || userId === identity.value)) {
      resultByIdentity.set(identity.key, {
        status: "resolved",
        matched_by: [identity.matchedBy],
        userId,
      });
    } else {
      resultByIdentity.set(identity.key, { status: "not_found", candidate_count: 0 });
    }
  }

  const evaluatedResults = identities.map((identity): EvaluatedResult => {
    const result = resultByIdentity.get(identity.key);
    if (!result) {
      throw new Error("User identity resolution result is missing");
    }
    return { source: identity.source, ...result };
  });

  const lookups = { status: "complete" as const, requests };
  const allResolved = evaluatedResults.every(
    (result): result is StrictResolvedEvidence & { userId: string } => result.status === "resolved",
  );
  if (allResolved) {
    return {
      lookups,
      safe_to_mention: true,
      results: evaluatedResults.map(({ userId, ...result }) => ({
        ...result,
        mention: `<@${userId}>`,
      })),
    };
  }

  return {
    lookups,
    safe_to_mention: false,
    results: evaluatedResults.map((result) => {
      if (result.status !== "resolved") {
        return result;
      }
      const { userId: _userId, ...withoutUserId } = result;
      return withoutUserId;
    }),
  };
}

export function incompleteStrictUserResolution(input: {
  requests: number;
  reason: StrictUserResolutionReason;
}): StrictUserResolution {
  return {
    lookups: {
      status: "incomplete",
      requests: input.requests,
      reason: input.reason,
    },
    safe_to_mention: false,
    results: [],
  };
}

function prepareIdentities(inputs: string[]): Identity[] {
  if (inputs.length === 0) {
    throw new Error("At least one user identity is required");
  }
  if (inputs.length > MAX_USER_RESOLUTION_IDENTITIES) {
    throw new Error(
      `At most ${MAX_USER_RESOLUTION_IDENTITIES} user identities may be resolved at once`,
    );
  }
  return inputs.map(parseIdentity);
}

function parseIdentity(input: string, index: number): Identity {
  const value = input.trim();
  const source = makeStrictUserOutputInert(value);
  if (isUserId(value)) {
    return {
      kind: "id",
      value,
      key: `id:${value}`,
      source,
      matchedBy: "input.id->slack.id",
    };
  }
  if (EMAIL_PATTERN.test(value)) {
    const email = value.toLowerCase();
    return {
      kind: "email",
      value: email,
      key: `email:${email}`,
      source,
      matchedBy: "input.email->slack.emailLookup",
    };
  }
  throw new Error(`User identity at index ${index} must be a canonical U/W ID or email`);
}

function parseVerifiedUserId(value: unknown): string | null {
  if (!isRecord(value) || Array.isArray(value)) {
    return null;
  }
  const id = typeof value.id === "string" && isUserId(value.id) ? value.id : null;
  const profile = isRecord(value.profile) && !Array.isArray(value.profile) ? value.profile : null;
  if (!id || id === "USLACKBOT" || !profile || value.deleted !== false || value.is_bot !== false) {
    return null;
  }

  const inactiveOrBotSignals = [
    value.is_connector_bot,
    value.is_workflow_bot,
    value.is_agentforce_bot,
    value.is_invited_user,
    value.suspended,
    value.is_forgotten,
    value.is_profile_only_user,
    profile.is_agentforce_bot,
    profile.is_sidekick_bot,
  ];
  if (inactiveOrBotSignals.some((signal) => signal != null && signal !== false)) {
    return null;
  }
  if (profile.bot_id != null && profile.bot_id !== "") {
    return null;
  }

  return id;
}

function parseExactEmailCandidates(results: unknown[], email: string): string[] {
  const candidates = new Set<string>();
  for (const result of results) {
    if (!isRecord(result) || Array.isArray(result)) {
      throw new Error("Slack users/search returned a malformed result");
    }
    const profile =
      isRecord(result.profile) && !Array.isArray(result.profile) ? result.profile : null;
    const resultEmail =
      profile && typeof profile.email === "string" ? profile.email.trim().toLowerCase() : undefined;
    if (resultEmail !== email) {
      continue;
    }
    const id = typeof result.id === "string" && isUserId(result.id) ? result.id : null;
    if (!id) {
      throw new Error("Slack users/search returned an exact email match without a valid user ID");
    }
    candidates.add(id);
  }
  return [...candidates];
}

function isNotFoundError(error: unknown, kind: Identity["kind"]): boolean {
  const expected = kind === "id" ? "user_not_found" : "users_not_found";
  if (error instanceof Error && error.message === expected) {
    return true;
  }
  if (!isRecord(error) || !isRecord(error.data) || Array.isArray(error.data)) {
    return false;
  }
  return error.data.error === expected;
}

function requestFailureReason(message: string): StrictUserResolutionReason {
  if (/(?:^|[^a-z])invalid_auth(?:$|[^a-z])/i.test(message)) {
    return "invalid_auth";
  }
  if (/(?:^|[^a-z])token_expired(?:$|[^a-z])/i.test(message)) {
    return "token_expired";
  }
  if (/timed out|timeout/i.test(message)) {
    return "request_timeout";
  }
  if (/rate[-_ ]?limit(?:ed)?/i.test(message)) {
    return "rate_limited";
  }
  return "request_failed";
}
