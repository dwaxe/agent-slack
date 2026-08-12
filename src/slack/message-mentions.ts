import { isRecord } from "../lib/object-type-guards.ts";
import {
  collectMrkdwnMentions,
  collectRichTextBlock,
  collectTextObjectMentions,
  markMentionScanIncomplete,
  type MentionScanState,
} from "./message-mention-scanner.ts";
import { collectAttachmentMentions } from "./message-mention-attachments.ts";
import { collectTableBlock, collectTaskCardBlock } from "./message-mention-block-extras.ts";
const PLAIN_TOP_LEVEL_BLOCKS = new Set(["divider", "file"]);

export type MentionEvidence = {
  schema: 2;
  complete: boolean;
  user_ids: string[];
  usergroup_ids: string[];
};

function hasOnlyKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function validateOptionalString(value: unknown, state: MentionScanState): void {
  if (value !== undefined && typeof value !== "string") {
    markMentionScanIncomplete(state);
  }
}

function validateOptionalBoolean(value: unknown, state: MentionScanState): void {
  if (value !== undefined && typeof value !== "boolean") {
    markMentionScanIncomplete(state);
  }
}

function validatePlainTextObject(value: unknown, state: MentionScanState): void {
  if (!isRecord(value) || value.type !== "plain_text" || typeof value.text !== "string") {
    markMentionScanIncomplete(state);
    return;
  }
  if (!hasOnlyKnownKeys(value, new Set(["type", "text", "emoji"]))) {
    markMentionScanIncomplete(state);
  }
  validateOptionalBoolean(value.emoji, state);
}

function collectOptionalTextObject(value: unknown, state: MentionScanState): void {
  if (value !== undefined) {
    collectTextObjectMentions(value, state);
  }
}

function collectSectionBlock(block: Record<string, unknown>, state: MentionScanState): void {
  if (
    !hasOnlyKnownKeys(block, new Set(["type", "block_id", "text", "fields", "accessory", "expand"]))
  ) {
    markMentionScanIncomplete(state);
  }
  validateOptionalString(block.block_id, state);
  validateOptionalBoolean(block.expand, state);
  if (block.accessory !== undefined) {
    markMentionScanIncomplete(state);
  }
  collectOptionalTextObject(block.text, state);
  if (block.fields === undefined) {
    if (block.text === undefined) {
      markMentionScanIncomplete(state);
    }
    return;
  }
  if (!Array.isArray(block.fields)) {
    markMentionScanIncomplete(state);
    return;
  }
  for (const field of block.fields) {
    collectTextObjectMentions(field, state);
  }
}

function validateImageElement(
  value: unknown,
  input: { state: MentionScanState; topLevel: boolean },
): void {
  const { state, topLevel } = input;
  if (!isRecord(value) || value.type !== "image") {
    markMentionScanIncomplete(state);
    return;
  }
  if (
    !hasOnlyKnownKeys(
      value,
      new Set([
        "type",
        "image_url",
        "slack_file",
        "alt_text",
        ...(topLevel ? ["block_id", "title"] : []),
      ]),
    )
  ) {
    markMentionScanIncomplete(state);
  }
  if (typeof value.alt_text !== "string") {
    markMentionScanIncomplete(state);
  }
  validateOptionalString(value.image_url, state);
  if (value.slack_file !== undefined) {
    if (!isRecord(value.slack_file)) {
      markMentionScanIncomplete(state);
    } else {
      if (!hasOnlyKnownKeys(value.slack_file, new Set(["id", "url"]))) {
        markMentionScanIncomplete(state);
      }
      validateOptionalString(value.slack_file.id, state);
      validateOptionalString(value.slack_file.url, state);
      if (value.slack_file.id === undefined && value.slack_file.url === undefined) {
        markMentionScanIncomplete(state);
      }
    }
  }
  if (value.image_url === undefined && value.slack_file === undefined) {
    markMentionScanIncomplete(state);
  }
}

function collectContextBlock(block: Record<string, unknown>, state: MentionScanState): void {
  if (!hasOnlyKnownKeys(block, new Set(["type", "block_id", "elements"]))) {
    markMentionScanIncomplete(state);
  }
  validateOptionalString(block.block_id, state);
  if (!Array.isArray(block.elements)) {
    markMentionScanIncomplete(state);
    return;
  }
  for (const element of block.elements) {
    if (!isRecord(element) || typeof element.type !== "string") {
      markMentionScanIncomplete(state);
    } else if (element.type === "mrkdwn" || element.type === "plain_text") {
      collectTextObjectMentions(element, state);
    } else if (element.type === "image") {
      validateImageElement(element, { state, topLevel: false });
    } else {
      markMentionScanIncomplete(state);
    }
  }
}

function collectPlainBlock(block: Record<string, unknown>, state: MentionScanState): void {
  if (block.type === "header") {
    if (!hasOnlyKnownKeys(block, new Set(["type", "block_id", "text"]))) {
      markMentionScanIncomplete(state);
    }
    validateOptionalString(block.block_id, state);
    validatePlainTextObject(block.text, state);
  } else if (block.type === "image") {
    if (
      !hasOnlyKnownKeys(
        block,
        new Set(["type", "block_id", "image_url", "slack_file", "alt_text", "title"]),
      )
    ) {
      markMentionScanIncomplete(state);
    }
    validateOptionalString(block.block_id, state);
    validateOptionalString(block.alt_text, state);
    if (block.title !== undefined) {
      validatePlainTextObject(block.title, state);
    }
    validateImageElement(block, { state, topLevel: true });
  } else if (block.type === "video") {
    if (
      !hasOnlyKnownKeys(
        block,
        new Set([
          "type",
          "block_id",
          "video_url",
          "thumbnail_url",
          "alt_text",
          "title",
          "title_url",
          "author_name",
          "provider_name",
          "provider_icon_url",
          "description",
        ]),
      )
    ) {
      markMentionScanIncomplete(state);
    }
    validateOptionalString(block.block_id, state);
    for (const key of ["video_url", "thumbnail_url", "alt_text"]) {
      if (typeof block[key] !== "string") {
        markMentionScanIncomplete(state);
      }
    }
    for (const key of ["title_url", "author_name", "provider_name", "provider_icon_url"]) {
      validateOptionalString(block[key], state);
    }
    validatePlainTextObject(block.title, state);
    if (block.description !== undefined) {
      validatePlainTextObject(block.description, state);
    }
  } else if (block.type === "divider") {
    if (!hasOnlyKnownKeys(block, new Set(["type", "block_id"]))) {
      markMentionScanIncomplete(state);
    }
    validateOptionalString(block.block_id, state);
  } else if (block.type === "file") {
    if (!hasOnlyKnownKeys(block, new Set(["type", "block_id", "source", "external_id"]))) {
      markMentionScanIncomplete(state);
    }
    validateOptionalString(block.block_id, state);
    if (typeof block.source !== "string" || typeof block.external_id !== "string") {
      markMentionScanIncomplete(state);
    }
  }
}

function collectTopLevelBlocks(blocks: unknown, state: MentionScanState): void {
  if (blocks === undefined) {
    return;
  }
  if (!Array.isArray(blocks)) {
    markMentionScanIncomplete(state);
    return;
  }
  for (const block of blocks) {
    if (!isRecord(block) || typeof block.type !== "string") {
      markMentionScanIncomplete(state);
      continue;
    }
    if (block.type === "rich_text") {
      collectRichTextBlock(block, state);
    } else if (block.type === "section") {
      collectSectionBlock(block, state);
    } else if (block.type === "context") {
      collectContextBlock(block, state);
    } else if (block.type === "table" || block.type === "data_table") {
      collectTableBlock(block, state);
    } else if (block.type === "task_card") {
      collectTaskCardBlock(block, state);
    } else if (
      block.type === "header" ||
      block.type === "image" ||
      block.type === "video" ||
      PLAIN_TOP_LEVEL_BLOCKS.has(block.type)
    ) {
      collectPlainBlock(block, state);
    } else {
      markMentionScanIncomplete(state);
    }
  }
}

export function collectDirectMessageMentions(input: {
  text?: string;
  mrkdwn?: unknown;
  blocks?: unknown;
  attachments?: unknown;
}): MentionEvidence {
  const state: MentionScanState = {
    complete: true,
    userIds: new Set<string>(),
    usergroupIds: new Set<string>(),
  };
  if (input.mrkdwn !== undefined && input.mrkdwn !== true && input.mrkdwn !== false) {
    markMentionScanIncomplete(state);
  }
  if (input.mrkdwn !== false && typeof input.text === "string") {
    collectMrkdwnMentions(input.text, state);
  }
  collectTopLevelBlocks(input.blocks, state);
  collectAttachmentMentions(input.attachments, state);

  return {
    schema: 2,
    complete: state.complete,
    user_ids: Array.from(state.userIds).sort(),
    usergroup_ids: Array.from(state.usergroupIds).sort(),
  };
}
