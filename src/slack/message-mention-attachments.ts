import { isRecord } from "../lib/object-type-guards.ts";
import {
  collectMrkdwnMentions,
  markMentionScanIncomplete,
  type MentionScanState,
} from "./message-mention-scanner.ts";

const KNOWN_SUBTYPE_FLAGS = new Set([
  "is_app_unfurl",
  "is_file_attachment",
  "is_msg_unfurl",
  "is_reply_unfurl",
  "is_share",
  "is_thread_root_unfurl",
]);
const KNOWN_KEYS = new Set([
  "actions",
  "app_id",
  "app_unfurl_url",
  "attachments",
  "author_icon",
  "author_id",
  "author_link",
  "author_name",
  "author_subname",
  "blocks",
  "bot_id",
  "bot_team_id",
  "callback_id",
  "channel_id",
  "channel_name",
  "channel_team",
  "color",
  "fallback",
  "fields",
  "file_id",
  "filename",
  "files",
  "footer",
  "footer_icon",
  "from_url",
  "hide_border",
  "hide_color",
  "id",
  "image_bytes",
  "image_height",
  "image_url",
  "image_width",
  "indent",
  "is_app_unfurl",
  "is_file_attachment",
  "is_msg_unfurl",
  "is_reply_unfurl",
  "is_share",
  "is_thread_root_unfurl",
  "list",
  "list_record",
  "list_record_id",
  "list_records",
  "list_schema",
  "list_view",
  "list_view_id",
  "message_blocks",
  "metadata",
  "mimetype",
  "mrkdwn_in",
  "msg_subtype",
  "original_url",
  "pretext",
  "preview",
  "reply_count",
  "service_icon",
  "service_name",
  "service_url",
  "size",
  "text",
  "thumb_height",
  "thumb_url",
  "thumb_width",
  "title",
  "title_link",
  "ts",
  "url",
  "video_html",
  "video_html_height",
  "video_html_width",
  "video_url",
]);
const UNSUPPORTED_NESTED_FIELDS = new Set([
  "actions",
  "attachments",
  "blocks",
  "files",
  "list",
  "list_record",
  "list_records",
  "list_schema",
  "list_view",
  "metadata",
  "preview",
]);

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateOptionalString(value: unknown, state: MentionScanState): void {
  if (value !== undefined && typeof value !== "string") {
    markMentionScanIncomplete(state);
  }
}

function isExcluded(attachment: Record<string, unknown>): boolean {
  return (
    attachment.is_share === true ||
    attachment.is_app_unfurl === true ||
    attachment.is_file_attachment === true ||
    attachment.is_msg_unfurl === true ||
    attachment.is_reply_unfurl === true ||
    attachment.is_thread_root_unfurl === true ||
    Array.isArray(attachment.message_blocks)
  );
}

function hasUnknownSubtype(attachment: Record<string, unknown>, state: MentionScanState): boolean {
  const unknown = Object.entries(attachment).some(
    ([key, value]) =>
      key.startsWith("is_") && (!KNOWN_SUBTYPE_FLAGS.has(key) || typeof value !== "boolean"),
  );
  if (unknown) {
    markMentionScanIncomplete(state);
  }
  return unknown;
}

function collectFields(
  attachment: Record<string, unknown>,
  input: { state: MentionScanState; includeMentions: boolean },
): void {
  const { state, includeMentions } = input;
  if (attachment.fields === undefined) {
    return;
  }
  if (!Array.isArray(attachment.fields)) {
    markMentionScanIncomplete(state);
    return;
  }
  for (const field of attachment.fields) {
    if (!isRecord(field)) {
      markMentionScanIncomplete(state);
      continue;
    }
    if (Object.keys(field).some((key) => !new Set(["title", "value", "short"]).has(key))) {
      markMentionScanIncomplete(state);
    }
    validateOptionalString(field.title, state);
    if (field.short !== undefined && typeof field.short !== "boolean") {
      markMentionScanIncomplete(state);
    }
    if (typeof field.value !== "string") {
      markMentionScanIncomplete(state);
      continue;
    }
    if (includeMentions) {
      collectMrkdwnMentions(field.value, state);
    }
  }
}

function validateNormalShape(attachment: Record<string, unknown>, state: MentionScanState): void {
  if (Object.keys(attachment).some((key) => !KNOWN_KEYS.has(key))) {
    markMentionScanIncomplete(state);
  }
  if (hasOwn(attachment, "msg_subtype")) {
    markMentionScanIncomplete(state);
  }
  if (hasOwn(attachment, "message_blocks") && !Array.isArray(attachment.message_blocks)) {
    markMentionScanIncomplete(state);
  }
  if (Array.from(UNSUPPORTED_NESTED_FIELDS).some((field) => hasOwn(attachment, field))) {
    markMentionScanIncomplete(state);
  }
  for (const [key, value] of Object.entries(attachment)) {
    if (key !== "fields" && key !== "mrkdwn_in" && (Array.isArray(value) || isRecord(value))) {
      markMentionScanIncomplete(state);
    }
  }
  validateOptionalString(attachment.pretext, state);
  validateOptionalString(attachment.text, state);
  collectFields(attachment, { state, includeMentions: false });
}

function collectEnabledFields(attachment: Record<string, unknown>, state: MentionScanState): void {
  if (!Array.isArray(attachment.mrkdwn_in)) {
    markMentionScanIncomplete(state);
    return;
  }
  const enabled = new Set<string>();
  for (const field of attachment.mrkdwn_in) {
    if (field === "pretext" || field === "text" || field === "fields") {
      enabled.add(field);
    } else {
      markMentionScanIncomplete(state);
    }
  }
  for (const field of ["pretext", "text"] as const) {
    if (enabled.has(field) && typeof attachment[field] === "string") {
      collectMrkdwnMentions(attachment[field], state);
    }
  }
  if (enabled.has("fields")) {
    collectFields(attachment, { state, includeMentions: true });
  }
}

export function collectAttachmentMentions(attachments: unknown, state: MentionScanState): void {
  if (attachments === undefined) {
    return;
  }
  if (!Array.isArray(attachments)) {
    markMentionScanIncomplete(state);
    return;
  }
  for (const attachment of attachments) {
    if (!isRecord(attachment)) {
      markMentionScanIncomplete(state);
      continue;
    }
    if (hasUnknownSubtype(attachment, state)) {
      continue;
    }
    if (Object.keys(attachment).some((key) => !KNOWN_KEYS.has(key))) {
      markMentionScanIncomplete(state);
    }
    if (isExcluded(attachment)) {
      continue;
    }
    validateNormalShape(attachment, state);
    if (attachment.mrkdwn_in !== undefined) {
      collectEnabledFields(attachment, state);
    }
  }
}
