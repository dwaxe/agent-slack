import type { CliContext } from "./context.ts";
import { parseMsgTarget } from "./targets.ts";
import { openDmChannel, resolveChannelId } from "../slack/channels.ts";
import type { SlackApiClient } from "../slack/client.ts";
import {
  cancelScheduledMessage as cancelScheduledMessageApi,
  findScheduledMessageReceiptIdentity,
  listScheduledMessages as listScheduledMessagesApi,
  normalizeScheduleLimit,
} from "../slack/scheduled-messages.ts";
import { resolveAuthenticatedMutationWorkspace } from "./mutation-receipt.ts";
import { resolveSlackNativeDraftEndpoint } from "./slack-native-draft-endpoint.ts";

export async function listScheduledMessages(input: {
  ctx: CliContext;
  options: {
    workspace?: string;
    channel?: string;
    cursor?: string;
    oldest?: string;
    latest?: string;
    limit?: string;
  };
}): Promise<Record<string, unknown>> {
  const channelTarget = input.options.channel
    ? parseMsgTarget(String(input.options.channel))
    : undefined;
  const workspaceUrl =
    channelTarget?.kind === "url"
      ? channelTarget.ref.workspace_url
      : input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  if (channelTarget?.kind === "channel") {
    await input.ctx.assertWorkspaceSpecifiedForChannelNames({
      workspaceUrl,
      channels: [channelTarget.channel],
    });
  }

  return await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client, auth, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = channelTarget
        ? await resolveScheduledChannelTarget(client, channelTarget)
        : undefined;
      const endpoint = await resolveSlackNativeDraftEndpoint({
        ctx: input.ctx,
        client,
        auth,
        workspaceUrl: workspace_url ?? workspaceUrl,
      });
      return await listScheduledMessagesApi(endpoint.client, {
        channelId,
        cursor: input.options.cursor,
        oldest: input.options.oldest,
        latest: input.options.latest,
        limit: normalizeScheduleLimit(input.options.limit),
        authType: endpoint.auth.auth_type,
      });
    },
  });
}

export async function cancelScheduledMessage(input: {
  ctx: CliContext;
  scheduledMessageId: string;
  options: { workspace?: string; channel: string };
}): Promise<Record<string, unknown>> {
  const channelTarget = parseMsgTarget(String(input.options.channel));
  const workspaceUrl =
    channelTarget.kind === "url"
      ? channelTarget.ref.workspace_url
      : input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  if (channelTarget.kind === "channel") {
    await input.ctx.assertWorkspaceSpecifiedForChannelNames({
      workspaceUrl,
      channels: [channelTarget.channel],
    });
  }

  return await input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const reconciliationStartedAt = input.ctx.removeScheduledSendReceipt ? new Date() : undefined;
      const { client, auth, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
      let exactWorkspaceUrl =
        workspace_url ??
        (channelTarget.kind === "url" ? channelTarget.ref.workspace_url : workspaceUrl);
      let scheduledIdentity:
        | Awaited<ReturnType<typeof findScheduledMessageReceiptIdentity>>
        | undefined;
      let reconciliationLookupFailed = false;
      if (input.ctx.removeScheduledSendReceipt) {
        exactWorkspaceUrl = await resolveAuthenticatedMutationWorkspace(client, exactWorkspaceUrl);
      }
      const channelId = await resolveScheduledChannelTarget(client, channelTarget);
      const endpoint = await resolveSlackNativeDraftEndpoint({
        ctx: input.ctx,
        client,
        auth,
        workspaceUrl: workspace_url ?? workspaceUrl,
      });
      if (input.ctx.removeScheduledSendReceipt) {
        try {
          scheduledIdentity = await findScheduledMessageReceiptIdentity(endpoint.client, {
            channelId,
            scheduledMessageId: input.scheduledMessageId,
            authType: endpoint.auth.auth_type,
          });
          reconciliationLookupFailed =
            scheduledIdentity === undefined || scheduledIdentity.unique === false;
        } catch (error) {
          reconciliationLookupFailed = true;
          process.stderr.write(
            `Warning: could not read the scheduled message for local provenance reconciliation: ${input.ctx.errorMessage(error)}\n`,
          );
        }
      }
      await cancelScheduledMessageApi(endpoint.client, {
        channelId,
        scheduledMessageId: input.scheduledMessageId,
        authType: endpoint.auth.auth_type,
      });
      const receiptCleanup: Record<string, unknown> = {};
      if (input.ctx.removeScheduledSendReceipt) {
        if (!exactWorkspaceUrl) {
          process.stderr.write(
            "Warning: scheduled message was cancelled, but no exact workspace URL was available to remove its local AI provenance receipt.\n",
          );
          receiptCleanup.receipt_removed = false;
        } else {
          try {
            const cleanup = await input.ctx.removeScheduledSendReceipt({
              workspaceUrl: exactWorkspaceUrl,
              channelId,
              scheduledMessageId: input.scheduledMessageId,
              content: scheduledIdentity?.unique ? scheduledIdentity.content : undefined,
              postAt: scheduledIdentity?.unique ? scheduledIdentity.postAt : undefined,
              credentialFingerprint: scheduledIdentity?.unique
                ? client.credentialFingerprint()
                : undefined,
              reconciledAt: reconciliationStartedAt,
            });
            receiptCleanup.receipt_removed =
              cleanup.finalized_receipt_removed || cleanup.pending_intent_removed;
            receiptCleanup.pending_intent_removed = cleanup.pending_intent_removed;
            if (reconciliationLookupFailed) {
              receiptCleanup.receipt_cleanup_complete = false;
            }
          } catch (error) {
            process.stderr.write(
              `Warning: scheduled message was cancelled, but its local AI provenance receipt could not be removed: ${input.ctx.errorMessage(error)}\n`,
            );
            receiptCleanup.receipt_removed = false;
          }
        }
      }
      return {
        ok: true,
        channel_id: channelId,
        scheduled_message_id: input.scheduledMessageId,
        ...receiptCleanup,
      };
    },
  });
}

async function resolveScheduledChannelTarget(
  client: SlackApiClient,
  target: ReturnType<typeof parseMsgTarget>,
): Promise<string> {
  if (target.kind === "url") {
    return target.ref.channel_id;
  }
  if (target.kind === "user") {
    return await openDmChannel(client, target.userId);
  }
  return await resolveChannelId(client, target.channel);
}
