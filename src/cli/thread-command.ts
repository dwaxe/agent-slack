import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { unsubscribeThread } from "../slack/thread-subscriptions.ts";
import { buildSlackMessageUrl, parseSlackMessageUrl } from "../slack/url.ts";
import { warnOnTruncatedSlackUrl } from "./message-url-warning.ts";
import { getString, isRecord } from "../lib/object-type-guards.ts";
import type { SlackApiClient, SlackAuth } from "../slack/client.ts";
import { isUserId } from "../slack/user-id.ts";

const TEAM_ID_PATTERN = /^T[A-Z0-9]{8,19}$/;

type ThreadSubscriptionEndpoint = {
  client: SlackApiClient;
  auth: SlackAuth;
  teamId?: string;
};

function getHttpsOrigin(value: unknown): string | undefined {
  const raw = getString(value);
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

async function resolveThreadSubscriptionEndpoint(input: {
  ctx: CliContext;
  workspaceClient: SlackApiClient;
  workspaceAuth: SlackAuth;
  workspaceUserId: string;
  workspaceTeamId: string;
}): Promise<ThreadSubscriptionEndpoint> {
  if (input.workspaceAuth.auth_type !== "browser") {
    throw new Error("Thread unsubscribe requires browser auth (xoxc token and xoxd cookie).");
  }

  const response = await input.workspaceClient.api("team.info", {});
  const team = isRecord(response.team) ? response.team : null;
  const teamId = team ? getString(team.id) : undefined;
  if (teamId !== input.workspaceTeamId) {
    throw new Error(
      "Slack team.info does not match the workspace verified by auth.test; refusing to unsubscribe.",
    );
  }
  const enterpriseId = team ? getString(team.enterprise_id)?.trim() : undefined;
  if (!enterpriseId) {
    return { client: input.workspaceClient, auth: input.workspaceAuth };
  }

  const enterpriseDomain = team
    ? getString(team.enterprise_domain)?.trim().toLowerCase()
    : undefined;
  if (!enterpriseDomain || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(enterpriseDomain)) {
    throw new Error(
      "Slack did not return a valid Enterprise Grid domain for thread subscriptions.",
    );
  }

  const enterpriseWorkspaceUrl = `https://${enterpriseDomain}.enterprise.slack.com`;
  const enterprise = await input.ctx.getClientForWorkspace(enterpriseWorkspaceUrl);
  if (enterprise.auth.auth_type !== "browser") {
    throw new Error(
      "Enterprise Grid thread unsubscribe requires browser auth for the organization.",
    );
  }
  const enterpriseIdentity = await enterprise.client.api("auth.test", {});
  if (getString(enterpriseIdentity.team_id)?.trim() !== enterpriseId) {
    throw new Error(
      "The resolved Enterprise Grid credentials do not match the target workspace's organization.",
    );
  }
  const enterpriseUserId = getString(enterpriseIdentity.user_id);
  if (enterpriseUserId !== input.workspaceUserId) {
    throw new Error(
      "The workspace and Enterprise Grid credentials do not belong to the same Slack user.",
    );
  }
  return { client: enterprise.client, auth: enterprise.auth, teamId };
}

export async function unsubscribeThreadTarget(input: {
  ctx: CliContext;
  targetInput: string;
  expectedUserId: string;
}): Promise<Record<string, unknown>> {
  const ref = parseSlackMessageUrl(input.targetInput);
  if (!ref.workspace_url.startsWith("https://")) {
    throw new Error("Thread unsubscribe requires an https Slack message URL.");
  }
  if (!isUserId(input.expectedUserId)) {
    throw new Error("--expected-user-id must be a canonical Slack user ID beginning with U or W.");
  }
  warnOnTruncatedSlackUrl(ref);

  return input.ctx.withAutoRefresh({
    workspaceUrl: ref.workspace_url,
    work: async () => {
      const { client, auth, workspace_url } = await input.ctx.getClientForWorkspace(
        ref.workspace_url,
      );
      if (auth.auth_type !== "browser") {
        throw new Error("Thread unsubscribe requires browser auth (xoxc token and xoxd cookie).");
      }

      // Bind every attempt, including an automatic post-refresh retry, to the
      // explicitly expected actor before any workspace or subscription lookup.
      const identity = await client.api("auth.test", {});
      const userId = getString(identity.user_id);
      if (userId !== input.expectedUserId) {
        throw new Error(
          "Authenticated Slack user does not match --expected-user-id; refusing to unsubscribe.",
        );
      }
      const targetOrigin = new URL(ref.workspace_url).origin;
      if (getHttpsOrigin(identity.url) !== targetOrigin) {
        throw new Error(
          "Slack auth.test workspace origin does not match the target URL; refusing to unsubscribe.",
        );
      }
      const workspaceTeamId = getString(identity.team_id);
      if (!workspaceTeamId || !TEAM_ID_PATTERN.test(workspaceTeamId)) {
        throw new Error(
          "Slack auth.test did not return a canonical workspace team ID; refusing to unsubscribe.",
        );
      }

      const threadTs = ref.thread_ts_hint ?? ref.message_ts;
      const subscription = await resolveThreadSubscriptionEndpoint({
        ctx: input.ctx,
        workspaceClient: client,
        workspaceAuth: auth,
        workspaceUserId: userId,
        workspaceTeamId,
      });
      const result = await unsubscribeThread({
        client,
        subscriptionClient: subscription.client,
        auth: subscription.auth,
        channelId: ref.channel_id,
        threadTs,
        teamId: subscription.teamId,
      });
      const resolvedWorkspaceUrl = workspace_url ?? ref.workspace_url;
      return pruneEmpty({
        ...result,
        user_id: userId,
        workspace_url: resolvedWorkspaceUrl,
        permalink: buildSlackMessageUrl({
          workspace_url: resolvedWorkspaceUrl,
          channel_id: ref.channel_id,
          message_ts: threadTs,
        }),
      }) as Record<string, unknown>;
    },
  });
}

export function registerThreadCommand(input: { program: Command; ctx: CliContext }): void {
  const threadCmd = input.program
    .command("thread")
    .description("Manage Slack thread subscriptions");

  threadCmd
    .command("unsubscribe")
    .description(
      "Unsubscribe from one thread (requires browser auth; uses an unsupported Slack API)",
    )
    .argument("<target>", "Exact Slack message URL for the thread root or one of its replies")
    .requiredOption(
      "--expected-user-id <id>",
      "Required canonical Slack actor ID (U... or W...); must match auth.test before subscription access",
    )
    .action(async (...args) => {
      const [targetInput, options] = args as [string, { expectedUserId: string }];
      try {
        const payload = await unsubscribeThreadTarget({
          ctx: input.ctx,
          targetInput,
          expectedUserId: options.expectedUserId,
        });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}
