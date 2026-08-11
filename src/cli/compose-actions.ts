import type { CliContext } from "./context.ts";
import { fetchMessage } from "../slack/messages.ts";
import { parseMsgTarget } from "./targets.ts";
import { resolveChannelId, resolveChannelName, normalizeChannelInput } from "../slack/channels.ts";
import { warnOnTruncatedSlackUrl } from "./message-url-warning.ts";
import { openDraftEditor } from "./draft-server.ts";
import {
  cancelMutationReceiptAfterFailure,
  finalizeMutationReceipt,
  reserveMutationReceipt,
} from "./mutation-receipt.ts";

export async function composeMessage(input: {
  ctx: CliContext;
  targetInput: string;
  initialText?: string;
  options: { workspace?: string; threadTs?: string };
}): Promise<Record<string, unknown>> {
  if (process.env.CI && !input.initialText) {
    throw new Error("In CI mode, initial text is required (no editor available)");
  }
  const target = parseMsgTarget(String(input.targetInput));
  if (target.kind === "user") {
    throw new Error(
      "message compose does not support user ID targets. Use a channel name, channel ID, or message URL.",
    );
  }

  // URL target: resolve thread context and send
  if (target.kind === "url") {
    const { ref } = target;
    warnOnTruncatedSlackUrl(ref);
    return input.ctx.withAutoRefresh({
      workspaceUrl: ref.workspace_url,
      work: async () => {
        const { client, workspace_url } = await input.ctx.getClientForWorkspace(ref.workspace_url);
        const msg = await fetchMessage(client, { ref });
        const threadTs = input.options.threadTs ?? msg.thread_ts ?? msg.ts;
        const channelName = await resolveChannelName(client, ref.channel_id);

        return draftWithEditor({
          channelName,
          channelId: ref.channel_id,
          workspaceUrl: workspace_url ?? ref.workspace_url,
          threadTs,
          initialText: input.initialText,
          ctx: input.ctx,
          client,
          sendFn: async (text: string) => {
            const resp = await client.api("chat.postMessage", {
              channel: ref.channel_id,
              text,
              thread_ts: threadTs,
            });
            return { ts: resp.ts as string };
          },
        });
      },
    });
  }

  // Channel name/ID target
  const workspaceUrl = input.ctx.effectiveWorkspaceUrl(input.options.workspace);
  await input.ctx.assertWorkspaceSpecifiedForChannelNames({
    workspaceUrl,
    channels: [String(target.channel)],
  });

  return input.ctx.withAutoRefresh({
    workspaceUrl,
    work: async () => {
      const { client, workspace_url } = await input.ctx.getClientForWorkspace(workspaceUrl);
      const channelId = await resolveChannelId(client, String(target.channel));
      const normalized = normalizeChannelInput(target.channel);
      const channelName =
        normalized.kind === "name" ? normalized.value : await resolveChannelName(client, channelId);

      return draftWithEditor({
        channelName,
        channelId,
        workspaceUrl: workspace_url ?? workspaceUrl,
        threadTs: input.options.threadTs,
        initialText: input.initialText,
        ctx: input.ctx,
        client,
        sendFn: async (text: string) => {
          const resp = await client.api("chat.postMessage", {
            channel: channelId,
            text,
            thread_ts: input.options.threadTs,
          });
          return { ts: resp.ts as string };
        },
      });
    },
  });
}

async function draftWithEditor(input: {
  channelName: string;
  channelId: string;
  workspaceUrl?: string;
  threadTs?: string;
  initialText?: string;
  ctx: CliContext;
  client: Parameters<typeof reserveMutationReceipt>[1]["client"];
  sendFn: (text: string) => Promise<{ ts: string }>;
}): Promise<Record<string, unknown>> {
  const sendWithReceipt = async (text: string) => {
    const intent = await reserveMutationReceipt(input.ctx, {
      client: input.client,
      workspaceUrl: input.workspaceUrl,
      channelId: input.channelId,
      threadTs: input.threadTs,
      action: "compose_send",
      content: text,
    });
    let result: { ts: string };
    try {
      result = await input.sendFn(text);
    } catch (error) {
      await cancelMutationReceiptAfterFailure(input.ctx, intent, error);
      throw error;
    }
    const receiptStatus = await finalizeMutationReceipt(input.ctx, intent, {
      ts: result.ts,
      threadTs: input.threadTs,
    });
    return {
      ...result,
      ...(typeof receiptStatus.receipt_recorded === "boolean"
        ? { receipt_recorded: receiptStatus.receipt_recorded }
        : {}),
    };
  };

  // In CI mode, skip the editor and send directly
  if (process.env.CI) {
    if (!input.initialText) {
      throw new Error("In CI mode, initial text is required (no editor available)");
    }
    const result = await sendWithReceipt(input.initialText);
    return {
      ok: true,
      sent: true,
      editor: "skipped",
      workspace_url: input.workspaceUrl,
      channel_id: input.channelId,
      ts: result.ts,
      thread_ts: input.threadTs,
      ...(result.receipt_recorded !== undefined
        ? { receipt_recorded: result.receipt_recorded }
        : {}),
    };
  }

  const result = await openDraftEditor({
    channelName: input.channelName,
    channelId: input.channelId,
    workspaceUrl: input.workspaceUrl,
    threadTs: input.threadTs,
    initialText: input.initialText,
    onSend: sendWithReceipt,
  });

  if ("cancelled" in result) {
    return { ok: true, cancelled: true };
  }

  return {
    ok: true,
    sent: true,
    workspace_url: input.workspaceUrl,
    channel_id: input.channelId,
    ts: result.ts,
    thread_ts: input.threadTs,
    ...(result.receipt_recorded !== undefined ? { receipt_recorded: result.receipt_recorded } : {}),
  };
}
