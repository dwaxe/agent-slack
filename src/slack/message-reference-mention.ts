import { isChannelId } from "./channels.ts";
import { isUserId } from "./user-id.ts";
import { normalizeSlackWorkspaceUrl } from "./workspace-url.ts";

const MESSAGE_TIMESTAMP_PATTERN = /^(0|[1-9]\d{0,12})\.\d{6}$/;

export const MESSAGE_MENTION_KEYS: ReadonlySet<string> = new Set([
  "type",
  "author_id",
  "channel_id",
  "message_ts",
  "text",
  "url",
]);

export function isValidMessageMention(value: Record<string, unknown>): boolean {
  if (
    !Array.from(MESSAGE_MENTION_KEYS).every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) ||
    typeof value.author_id !== "string" ||
    !isUserId(value.author_id) ||
    value.author_id.length > 20 ||
    typeof value.channel_id !== "string" ||
    !isChannelId(value.channel_id) ||
    value.channel_id.length > 20 ||
    typeof value.message_ts !== "string" ||
    !MESSAGE_TIMESTAMP_PATTERN.test(value.message_ts) ||
    typeof value.text !== "string" ||
    typeof value.url !== "string"
  ) {
    return false;
  }

  try {
    const origin = normalizeSlackWorkspaceUrl(new URL(value.url).origin);
    return (
      value.url === `${origin}/archives/${value.channel_id}/p${value.message_ts.replace(".", "")}`
    );
  } catch {
    return false;
  }
}
