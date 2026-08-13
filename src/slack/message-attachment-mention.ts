import { isRecord } from "../lib/object-type-guards.ts";

const OPTIONAL_STRING_KEYS = [
  "text",
  "app_id",
  "entity_id",
  "icon_url",
  "channel_id",
  "ts",
  "icon_name",
  "reference_object_type",
  "product_name",
] as const;
const STYLE_KEYS = new Set([
  "bold",
  "client_highlight",
  "highlight",
  "italic",
  "strike",
  "underline",
  "unlink",
]);

export const ATTACHMENT_MENTION_KEYS: ReadonlySet<string> = new Set([
  "type",
  "url",
  ...OPTIONAL_STRING_KEYS,
  "full_size_preview_enabled",
  "style",
]);

export function isValidAttachmentMention(value: Record<string, unknown>): boolean {
  if (typeof value.url !== "string") {
    return false;
  }
  if (
    OPTIONAL_STRING_KEYS.some((key) => value[key] !== undefined && typeof value[key] !== "string")
  ) {
    return false;
  }
  if (
    value.full_size_preview_enabled !== undefined &&
    typeof value.full_size_preview_enabled !== "boolean"
  ) {
    return false;
  }
  if (value.style === undefined) {
    return true;
  }
  return (
    isRecord(value.style) &&
    !Array.isArray(value.style) &&
    Object.keys(value.style).every((key) => STYLE_KEYS.has(key)) &&
    Object.values(value.style).every((property) => typeof property === "boolean")
  );
}
