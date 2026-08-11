import {
  normalizeReceiptWorkspaceUrl,
  type ReceiptAction,
  type SendReceiptIntent,
} from "../lib/send-receipts.ts";
import { getString } from "../lib/object-type-guards.ts";
import type { SlackApiClient } from "../slack/client.ts";
import type { CliContext } from "./context.ts";

export async function reserveMutationReceipt(
  ctx: CliContext,
  input: {
    client: SlackApiClient;
    workspaceUrl?: string;
    authenticatedWorkspaceUrl?: string;
    channelId: string;
    ts?: string;
    threadTs?: string;
    action: ReceiptAction;
    content: string;
    postAt?: number;
  },
): Promise<SendReceiptIntent | undefined> {
  if (!ctx.reserveSendReceipt) {
    return undefined;
  }
  if (!ctx.finalizeSendReceipt || !ctx.cancelSendReceipt) {
    throw new Error("Local AI provenance receipt store is incompletely configured");
  }
  // Token-only standard auth can discover its exact workspace through
  // auth.test. Do that before reserving or mutating Slack.
  const workspaceUrl = input.authenticatedWorkspaceUrl
    ? normalizeReceiptWorkspaceUrl(input.authenticatedWorkspaceUrl)
    : await resolveAuthenticatedMutationWorkspace(input.client, input.workspaceUrl);
  return ctx.reserveSendReceipt({
    workspaceUrl,
    channelId: input.channelId,
    credentialFingerprint: input.client.credentialFingerprint(),
    ts: input.ts,
    threadTs: input.threadTs,
    action: input.action,
    content: input.content,
    postAt: input.postAt,
  });
}

export async function resolveAuthenticatedMutationWorkspace(
  client: SlackApiClient,
  claimedWorkspaceUrl?: string,
): Promise<string> {
  const auth = await client.api("auth.test", {});
  const rawAuthenticatedUrl = getString(auth.url)?.trim();
  if (!rawAuthenticatedUrl) {
    throw new Error("Slack auth.test did not return an exact workspace URL for provenance");
  }
  const authenticatedWorkspaceUrl = normalizeReceiptWorkspaceUrl(rawAuthenticatedUrl);
  const claim = claimedWorkspaceUrl?.trim();
  if (!claim) {
    return authenticatedWorkspaceUrl;
  }

  let claimedOrigin: string | undefined;
  try {
    claimedOrigin = normalizeReceiptWorkspaceUrl(claim);
  } catch {
    const normalizedSelector = claim.toLowerCase();
    const authenticatedHost = new URL(authenticatedWorkspaceUrl).hostname.toLowerCase();
    const shortHost = authenticatedHost.replace(/\.(?:slack\.com|slack-gov\.com)$/i, "");
    if (
      !authenticatedWorkspaceUrl.toLowerCase().includes(normalizedSelector) &&
      !authenticatedHost.includes(normalizedSelector) &&
      !shortHost.includes(normalizedSelector)
    ) {
      throw new Error(
        `Slack credentials authenticate to ${authenticatedWorkspaceUrl}, which does not match workspace selector ${JSON.stringify(claim)}`,
      );
    }
    return authenticatedWorkspaceUrl;
  }

  if (claimedOrigin !== authenticatedWorkspaceUrl) {
    throw new Error(
      `Slack credentials authenticate to ${authenticatedWorkspaceUrl}, not requested workspace ${claimedOrigin}`,
    );
  }
  return authenticatedWorkspaceUrl;
}

export async function finalizeMutationReceipt(
  ctx: CliContext,
  intent: SendReceiptIntent | undefined,
  identity: { ts?: string; scheduledMessageId?: string; threadTs?: string },
): Promise<Record<string, unknown>> {
  if (!intent) {
    return {};
  }
  try {
    await ctx.finalizeSendReceipt!({
      intentId: intent.intent_id,
      ts: identity.ts,
      scheduledMessageId: identity.scheduledMessageId,
      threadTs: identity.threadTs,
    });
    return { receipt_recorded: true };
  } catch (error) {
    process.stderr.write(
      `Warning: Slack mutation succeeded, but its local AI provenance intent remains unresolved: ${ctx.errorMessage(error)}\n`,
    );
    return { receipt_recorded: false };
  }
}

export async function cancelMutationReceiptAfterFailure(
  ctx: CliContext,
  intent: SendReceiptIntent | undefined,
  slackError: unknown,
): Promise<void> {
  if (!intent || !ctx.cancelSendReceipt) {
    return;
  }
  if (!isClearlyTerminalSlackRejection(slackError)) {
    process.stderr.write(
      "Warning: Slack mutation outcome is unknown; retaining its local AI provenance intent.\n",
    );
    return;
  }
  try {
    await ctx.cancelSendReceipt({ intentId: intent.intent_id });
  } catch (error) {
    process.stderr.write(
      `Warning: Slack rejected the mutation, but its local AI provenance intent could not be removed: ${ctx.errorMessage(error)}\n`,
    );
  }
}

function isClearlyTerminalSlackRejection(error: unknown): boolean {
  const values: string[] = [error instanceof Error ? error.message : String(error)];
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.code === "string") {
      values.push(record.code);
    }
    if (record.data && typeof record.data === "object") {
      const slackError = (record.data as Record<string, unknown>).error;
      if (typeof slackError === "string") {
        values.push(slackError);
      }
    }
  }
  const terminalCodes = [
    "invalid_auth",
    "token_expired",
    "account_inactive",
    "missing_scope",
    "not_allowed_token_type",
    "channel_not_found",
    "not_in_channel",
    "is_archived",
    "message_not_found",
    "cant_update_message",
    "edit_window_closed",
    "msg_too_long",
    "no_text",
    "invalid_blocks",
    "invalid_arguments",
    "restricted_action",
  ];
  return values.some((value) =>
    terminalCodes.some((code) => new RegExp(`(?:^|[^a-z_])${code}(?:$|[^a-z_])`, "i").test(value)),
  );
}
