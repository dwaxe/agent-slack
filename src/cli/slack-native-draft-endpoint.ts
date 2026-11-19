import { getString, isRecord } from "../lib/object-type-guards.ts";
import type { SlackApiClient, SlackAuth } from "../slack/client.ts";
import { isUserId } from "../slack/user-id.ts";
import type { CliContext } from "./context.ts";

const TEAM_ID_PATTERN = /^T[A-Z0-9]{8,19}$/;
const ENTERPRISE_ID_PATTERN = /^E[A-Z0-9]{8,19}$/;

export type SlackNativeDraftEndpoint = {
  client: SlackApiClient;
  auth: SlackAuth;
  workspaceUrl?: string;
};

/**
 * Slack routes drafts.* calls through the organization on Enterprise Grid.
 * Bind that organization credential to the same enterprise and user before
 * using it for a workspace-targeted scheduled message.
 */
export async function resolveSlackNativeDraftEndpoint(input: {
  getClientForWorkspace: CliContext["getClientForWorkspace"];
  client: SlackApiClient;
  auth: SlackAuth;
  workspaceUrl?: string;
}): Promise<SlackNativeDraftEndpoint> {
  if (input.auth.auth_type !== "browser" || isEnterpriseWorkspaceUrl(input.workspaceUrl)) {
    return {
      client: input.client,
      auth: input.auth,
      workspaceUrl: input.workspaceUrl,
    };
  }

  const identity = await input.client.api("auth.test", {});
  const workspaceUserId = getString(identity.user_id);
  const workspaceTeamId = getString(identity.team_id);
  if (!workspaceUserId || !isUserId(workspaceUserId)) {
    throw new Error("Slack auth.test did not return a canonical user ID for native drafts.");
  }
  if (!workspaceTeamId || !TEAM_ID_PATTERN.test(workspaceTeamId)) {
    throw new Error(
      "Slack auth.test did not return a canonical workspace team ID for native drafts.",
    );
  }
  if (input.workspaceUrl && getHttpsOrigin(identity.url) !== getHttpsOrigin(input.workspaceUrl)) {
    throw new Error(
      "Slack auth.test workspace origin does not match the selected workspace for native drafts.",
    );
  }

  const response = await input.client.api("team.info", {});
  const team = isRecord(response.team) ? response.team : null;
  if (!team || getString(team.id) !== workspaceTeamId) {
    throw new Error(
      "Slack team.info does not match the workspace verified by auth.test for native drafts.",
    );
  }
  const enterpriseId = getString(team.enterprise_id)?.trim();
  if (!enterpriseId) {
    return {
      client: input.client,
      auth: input.auth,
      workspaceUrl: input.workspaceUrl,
    };
  }
  if (!ENTERPRISE_ID_PATTERN.test(enterpriseId)) {
    throw new Error("Slack team.info returned an invalid Enterprise Grid ID for native drafts.");
  }

  const enterpriseDomain = getString(team.enterprise_domain)?.trim().toLowerCase();
  if (!enterpriseDomain || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(enterpriseDomain)) {
    throw new Error("Slack did not return a valid Enterprise Grid domain for native drafts.");
  }
  const enterpriseWorkspaceUrl = `https://${enterpriseDomain}.enterprise.slack.com`;
  let enterprise: Awaited<ReturnType<CliContext["getClientForWorkspace"]>>;
  try {
    enterprise = await input.getClientForWorkspace(enterpriseWorkspaceUrl, {
      excludeAuth: input.auth,
    });
  } catch (error) {
    throw missingOrganizationCredentialsError(enterpriseWorkspaceUrl, error);
  }
  if (
    enterprise.auth.auth_type !== "browser" ||
    enterprise.auth.xoxc_token === input.auth.xoxc_token
  ) {
    throw missingOrganizationCredentialsError(enterpriseWorkspaceUrl);
  }
  const enterpriseIdentity = await enterprise.client.api("auth.test", {});
  if (getString(enterpriseIdentity.team_id)?.trim() !== enterpriseId) {
    throw new Error(
      "The resolved Enterprise Grid credentials do not match the target workspace's organization.",
    );
  }
  if (getString(enterpriseIdentity.user_id) !== workspaceUserId) {
    throw new Error(
      "The workspace and Enterprise Grid credentials do not belong to the same Slack user.",
    );
  }
  return {
    client: enterprise.client,
    auth: enterprise.auth,
    workspaceUrl: enterprise.workspace_url ?? enterpriseWorkspaceUrl,
  };
}

/**
 * True when a Slack failure is the `team_is_restricted` platform error. The
 * browser transport throws it as the bare message; the WebClient wraps it in
 * a PlatformError whose message and `data.error` both carry the code.
 */
export function isTeamRestrictedError(error: unknown): boolean {
  if (isRecord(error)) {
    const data = isRecord(error.data) ? error.data : undefined;
    if (data && getString(data.error) === "team_is_restricted") {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /(?:^|[^a-z])team_is_restricted(?:$|[^a-z])/.test(message);
}

/** Clients whose organization endpoint is currently being resolved. */
const resolvingEnterpriseFor = new WeakSet<SlackApiClient>();

/**
 * Run an operation against the selected workspace client, retrying it once
 * through the verified Enterprise Grid organization endpoint when Slack
 * rejects the workspace-addressed call with `team_is_restricted`. Slack
 * applies that restriction per addressing domain, not per method: on Grid,
 * drafts.list and drafts.delete fail against a child workspace domain while
 * the identical calls succeed against the organization domain, and any other
 * method can be restricted the same way. Only the retried operation changes
 * endpoint — the caller keeps its selected client for everything else. When
 * no distinct organization endpoint is available (non-Grid workspace,
 * already on the organization domain, standard auth, or organization
 * credentials not configured), the original error surfaces unchanged.
 *
 * Resolution itself calls auth.test/team.info on the selected client, which
 * may be a client whose calls already route through this fallback (see
 * attachEnterpriseFallback). While a client's endpoint is being resolved,
 * nested fallbacks for that client are suppressed so those verification
 * calls run as-is and a restricted verification call cannot recurse.
 */
export async function withEnterpriseFallback<T>(input: {
  getClientForWorkspace: CliContext["getClientForWorkspace"];
  client: SlackApiClient;
  auth: SlackAuth;
  workspaceUrl?: string;
  work: (client: SlackApiClient) => Promise<T>;
}): Promise<{ result: T; routedViaWorkspaceUrl?: string }> {
  try {
    return { result: await input.work(input.client) };
  } catch (error) {
    if (!isTeamRestrictedError(error) || resolvingEnterpriseFor.has(input.client)) {
      throw error;
    }
    let endpoint: SlackNativeDraftEndpoint;
    resolvingEnterpriseFor.add(input.client);
    try {
      endpoint = await resolveSlackNativeDraftEndpoint({
        getClientForWorkspace: input.getClientForWorkspace,
        client: input.client,
        auth: input.auth,
        workspaceUrl: input.workspaceUrl,
      });
    } catch {
      throw error;
    } finally {
      resolvingEnterpriseFor.delete(input.client);
    }
    if (endpoint.client === input.client) {
      throw error;
    }
    const result = await input.work(endpoint.client);
    return { result, routedViaWorkspaceUrl: endpoint.workspaceUrl };
  }
}

/** The drafts.* entry point to the shared fallback, kept under its original name. */
export const withEnterpriseDraftFallback = withEnterpriseFallback;

/** Clients that already carry the per-call enterprise fallback. */
const enterpriseFallbackAttached = new WeakSet<SlackApiClient>();

/**
 * Attach the shared enterprise fallback to a client so every API call it
 * makes retries once through the verified organization endpoint on
 * `team_is_restricted`, without the caller wrapping each operation. This is
 * the per-call form of withEnterpriseFallback, applied by the client factory
 * (getClientForWorkspace) to every client it hands out, so all commands —
 * not just drafts — get the fallback. A reroute is recorded on the client as
 * `routedViaWorkspaceUrl`, the same note the operation-level wrapper returns
 * for command output. The edge user-search transport is not workspace-domain
 * addressed and is left unwrapped.
 */
export function attachEnterpriseFallback(input: {
  getClientForWorkspace: CliContext["getClientForWorkspace"];
  client: SlackApiClient;
  auth: SlackAuth;
  workspaceUrl?: string;
}): SlackApiClient {
  const { client } = input;
  if (enterpriseFallbackAttached.has(client)) {
    return client;
  }
  enterpriseFallbackAttached.add(client);
  const rawApi = client.api.bind(client);
  const rawApiMultipart = client.apiMultipart.bind(client);
  const route = async <T>(raw: (target: SlackApiClient) => Promise<T>): Promise<T> => {
    const { result, routedViaWorkspaceUrl } = await withEnterpriseFallback({
      getClientForWorkspace: input.getClientForWorkspace,
      client,
      auth: input.auth,
      workspaceUrl: input.workspaceUrl,
      work: raw,
    });
    if (routedViaWorkspaceUrl) {
      client.routedViaWorkspaceUrl = routedViaWorkspaceUrl;
    }
    return result;
  };
  client.api = (method: string, params: Record<string, unknown> = {}) =>
    route((target) => (target === client ? rawApi(method, params) : target.api(method, params)));
  client.apiMultipart = (method: string, params: Record<string, unknown> = {}) =>
    route((target) =>
      target === client ? rawApiMultipart(method, params) : target.apiMultipart(method, params),
    );
  return client;
}

function missingOrganizationCredentialsError(workspaceUrl: string, cause?: unknown): Error {
  return new Error(
    `Enterprise Grid native drafts require separate organization browser credentials for ${workspaceUrl}. Import or configure that organization workspace before scheduling, listing, or cancelling native schedules.`,
    { cause },
  );
}

function isEnterpriseWorkspaceUrl(workspaceUrl: string | undefined): boolean {
  if (!workspaceUrl) {
    return false;
  }
  try {
    return new URL(workspaceUrl).hostname.endsWith(".enterprise.slack.com");
  } catch {
    return false;
  }
}

function getHttpsOrigin(value: unknown): string | undefined {
  const raw = getString(value);
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
