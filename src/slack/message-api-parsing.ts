import type { SlackApiClient } from "./client.ts";
import type { SlackFileSummary, SlackMessageSummary } from "./messages.ts";
import { getNumber, getString, isRecord } from "../lib/object-type-guards.ts";
import { slackMrkdwnToMarkdown } from "./mrkdwn.ts";

export function toSlackFileSummary(value: unknown): SlackFileSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: getString(value.name),
    title: getString(value.title),
    mimetype: getString(value.mimetype),
    filetype: getString(value.filetype),
    mode: getString(value.mode),
    permalink: getString(value.permalink),
    url_private: getString(value.url_private),
    url_private_download: getString(value.url_private_download),
    size: getNumber(value.size),
  };
}

export function toSlackMessageSummary(input: {
  channelId: string;
  message: Record<string, unknown>;
  fallbackTs?: string;
  files?: SlackFileSummary[];
}): SlackMessageSummary {
  const text = getString(input.message.text) ?? "";
  return {
    channel_id: input.channelId,
    ts: getString(input.message.ts) ?? input.fallbackTs ?? "",
    thread_ts: getString(input.message.thread_ts),
    reply_count: getNumber(input.message.reply_count),
    user: getString(input.message.user),
    bot_id: getString(input.message.bot_id),
    text,
    markdown: slackMrkdwnToMarkdown(text),
    // Preserve malformed/future values so notification evidence can fail closed
    // instead of silently treating them as Slack's default `true`.
    mrkdwn: input.message.mrkdwn,
    blocks: input.message.blocks,
    attachments: input.message.attachments,
    files: input.files && input.files.length > 0 ? input.files : undefined,
    reactions: Array.isArray(input.message.reactions)
      ? (input.message.reactions as unknown[])
      : undefined,
  };
}

export async function enrichFiles(
  client: SlackApiClient,
  files: SlackFileSummary[],
): Promise<SlackFileSummary[]> {
  const out: SlackFileSummary[] = [];
  for (const f of files) {
    if (f.mode === "snippet" || !f.url_private_download) {
      try {
        const info = await client.api("files.info", { file: f.id });
        const file = isRecord(info.file) ? info.file : null;
        out.push({
          ...f,
          name: f.name ?? getString(file?.name),
          title: f.title ?? getString(file?.title),
          mimetype: f.mimetype ?? getString(file?.mimetype),
          filetype: f.filetype ?? getString(file?.filetype),
          mode: f.mode ?? getString(file?.mode),
          permalink: f.permalink ?? getString(file?.permalink),
          url_private: f.url_private ?? getString(file?.url_private),
          url_private_download: f.url_private_download ?? getString(file?.url_private_download),
          snippet: {
            content: getString(file?.content),
            language: getString(file?.filetype),
          },
        });
        continue;
      } catch {
        // ignore and fall back to summary
      }
    }
    out.push(f);
  }
  return out;
}
