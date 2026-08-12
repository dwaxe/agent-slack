import type { Command } from "commander";
import type { CliContext } from "./context.ts";
import { pruneEmpty } from "../lib/compact-json.ts";
import { unsubscribeThread } from "../slack/thread-subscriptions.ts";
import { buildSlackMessageUrl, parseSlackMessageUrl } from "../slack/url.ts";
import { warnOnTruncatedSlackUrl } from "./message-url-warning.ts";
import { getString, isRecord } from "../lib/object-type-guards.ts";
import type { SlackApiClient, SlackAuth } from "../slack/client.ts";

type ThreadSubscriptionEndpoint = {
  client: SlackApiClient;
  auth: SlackAuth;
  teamId?: string;
};

async function resolveThreadSubscriptionEndpoint(input: {
  ctx: CliContext;
  workspaceClient: SlackApiClient;
  workspaceAuth: SlackAuth;
}): Promise<ThreadSubscriptionEndpoint> {
  if (input.workspaceAuth.auth_type !== "browser") {
    throw new Error("Thread unsubscribe requires browser auth (xoxc token and xoxd cookie).");
  }

  const response = await input.workspaceClient.api("team.info", {});
  const team = isRecord(response.team) ? response.team : null;
  const teamId = team ? getString(team.id)?.trim() : undefined;
  const enterpriseId = team ? getString(team.enterprise_id)?.trim() : undefined;
  if (!enterpriseId) {
    return { client: input.workspaceClient, auth: input.workspaceAuth };
  }
  if (!teamId) {
    throw new Error("Slack did not return the workspace team ID required for Enterprise Grid.");
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
  const [workspaceIdentity, enterpriseIdentity] = await Promise.all([
    input.workspaceClient.api("auth.test", {}),
    enterprise.client.api("auth.test", {}),
  ]);
  if (getString(enterpriseIdentity.team_id)?.trim() !== enterpriseId) {
    throw new Error(
      "The resolved Enterprise Grid credentials do not match the target workspace's organization.",
    );
  }
  const workspaceUserId = getString(workspaceIdentity.user_id)?.trim();
  const enterpriseUserId = getString(enterpriseIdentity.user_id)?.trim();
  if (!workspaceUserId || !enterpriseUserId || workspaceUserId !== enterpriseUserId) {
    throw new Error(
      "The workspace and Enterprise Grid credentials do not belong to the same Slack user.",
    );
  }
  return { client: enterprise.client, auth: enterprise.auth, teamId };
}

export async function unsubscribeThreadTarget(input: {
  ctx: CliContext;
  targetInput: string;
}): Promise<Record<string, unknown>> {
  const ref = parseSlackMessageUrl(input.targetInput);
  if (!ref.workspace_url.startsWith("https://")) {
    throw new Error("Thread unsubscribe requires an https Slack message URL.");
  }
  warnOnTruncatedSlackUrl(ref);

  return input.ctx.withAutoRefresh({
    workspaceUrl: ref.workspace_url,
    work: async () => {
      const { client, auth, workspace_url } = await input.ctx.getClientForWorkspace(
        ref.workspace_url,
      );
      const threadTs = ref.thread_ts_hint ?? ref.message_ts;
      const subscription = await resolveThreadSubscriptionEndpoint({
        ctx: input.ctx,
        workspaceClient: client,
        workspaceAuth: auth,
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
    .action(async (...args) => {
      const [targetInput] = args as [string];
      try {
        const payload = await unsubscribeThreadTarget({
          ctx: input.ctx,
          targetInput,
        });
        console.log(JSON.stringify(payload, null, 2));
      } catch (err: unknown) {
        console.error(input.ctx.errorMessage(err));
        process.exitCode = 1;
      }
    });
}
