import { isRecord } from "../lib/object-type-guards.ts";
import type { SlackApiClient } from "./client.ts";
import { isUserId } from "./user-id.ts";

type Identity = { kind: "id"; value: string } | { kind: "email"; value: string };

type ResolutionResult = {
  index: number;
  status: "resolved" | "unresolved";
  mention?: `<@${string}>`;
};

type InternalResult = ResolutionResult & { userId?: string };

export type UserResolution = {
  safe_to_mention: boolean;
  results: ResolutionResult[];
};

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function resolveStrictUserIdentities(input: {
  client: SlackApiClient;
  identities: string[];
}): Promise<UserResolution> {
  if (input.identities.length === 0) {
    throw new Error("At least one user identity is required");
  }

  const identities = input.identities.map(parseIdentity);
  const results: InternalResult[] = [];

  for (const [index, identity] of identities.entries()) {
    let response: Record<string, unknown>;
    try {
      response =
        identity.kind === "id"
          ? await input.client.api("users.info", { user: identity.value })
          : await input.client.api("users.lookupByEmail", { email: identity.value });
    } catch (error) {
      if (isNotFoundError(error, identity.kind)) {
        results.push({ index, status: "unresolved" });
        continue;
      }
      throw error;
    }

    const userId = parseVerifiedUserId(response.user);
    const matchesInput = userId && (identity.kind === "email" || userId === identity.value);
    results.push(
      matchesInput ? { index, status: "resolved", userId } : { index, status: "unresolved" },
    );
  }

  if (results.every((result) => result.status === "resolved")) {
    return {
      safe_to_mention: true,
      results: results.map((result) => ({
        index: result.index,
        status: "resolved",
        mention: `<@${result.userId!}>`,
      })),
    };
  }

  return {
    safe_to_mention: false,
    results: results.map(({ index, status }) => ({ index, status })),
  };
}

function parseIdentity(input: string, index: number): Identity {
  const value = input.trim();
  if (isUserId(value)) {
    return { kind: "id", value };
  }
  if (EMAIL_PATTERN.test(value)) {
    return { kind: "email", value: value.toLowerCase() };
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
