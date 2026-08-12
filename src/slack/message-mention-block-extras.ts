import { isRecord } from "../lib/object-type-guards.ts";
import {
  collectRichTextBlock,
  markMentionScanIncomplete,
  type MentionScanState,
} from "./message-mention-scanner.ts";

const TASK_STATUSES = new Set(["pending", "in_progress", "complete", "error"]);

function hasOnlyKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function validateOptionalString(value: unknown, state: MentionScanState): void {
  if (value !== undefined && typeof value !== "string") {
    markMentionScanIncomplete(state);
  }
}

function validateOptionalNumber(value: unknown, state: MentionScanState): void {
  if (value !== undefined && typeof value !== "number") {
    markMentionScanIncomplete(state);
  }
}

function validateTableCell(cell: unknown, state: MentionScanState): void {
  if (!isRecord(cell) || typeof cell.type !== "string") {
    markMentionScanIncomplete(state);
  } else if (cell.type === "rich_text") {
    collectRichTextBlock(cell, state);
  } else if (cell.type === "raw_text") {
    if (!hasOnlyKnownKeys(cell, new Set(["type", "text"])) || typeof cell.text !== "string") {
      markMentionScanIncomplete(state);
    }
  } else if (cell.type === "raw_number") {
    if (
      !hasOnlyKnownKeys(cell, new Set(["type", "value", "text"])) ||
      typeof cell.value !== "number" ||
      typeof cell.text !== "string"
    ) {
      markMentionScanIncomplete(state);
    }
  } else {
    markMentionScanIncomplete(state);
  }
}

function validateColumnSettings(value: unknown, state: MentionScanState): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    markMentionScanIncomplete(state);
    return;
  }
  for (const setting of value) {
    if (setting === null) {
      continue;
    }
    if (!isRecord(setting)) {
      markMentionScanIncomplete(state);
      continue;
    }
    if (!hasOnlyKnownKeys(setting, new Set(["align", "is_wrapped"]))) {
      markMentionScanIncomplete(state);
    }
    if (
      setting.align !== undefined &&
      setting.align !== "left" &&
      setting.align !== "center" &&
      setting.align !== "right"
    ) {
      markMentionScanIncomplete(state);
    }
    if (setting.is_wrapped !== undefined && typeof setting.is_wrapped !== "boolean") {
      markMentionScanIncomplete(state);
    }
  }
}

export function collectTableBlock(block: Record<string, unknown>, state: MentionScanState): void {
  if (block.type === "table") {
    if (!hasOnlyKnownKeys(block, new Set(["type", "block_id", "rows", "column_settings"]))) {
      markMentionScanIncomplete(state);
    }
    validateColumnSettings(block.column_settings, state);
  } else {
    const keys = new Set([
      "type",
      "block_id",
      "rows",
      "page_size",
      "caption",
      "row_header_column_index",
    ]);
    if (!hasOnlyKnownKeys(block, keys) || typeof block.caption !== "string") {
      markMentionScanIncomplete(state);
    }
    validateOptionalNumber(block.page_size, state);
    validateOptionalNumber(block.row_header_column_index, state);
  }
  validateOptionalString(block.block_id, state);
  if (!Array.isArray(block.rows)) {
    markMentionScanIncomplete(state);
    return;
  }
  for (const row of block.rows) {
    if (!Array.isArray(row)) {
      markMentionScanIncomplete(state);
      continue;
    }
    for (const cell of row) {
      validateTableCell(cell, state);
    }
  }
}

export function collectTaskCardBlock(
  block: Record<string, unknown>,
  state: MentionScanState,
): void {
  const keys = new Set([
    "type",
    "block_id",
    "task_id",
    "title",
    "details",
    "output",
    "sources",
    "status",
  ]);
  if (!hasOnlyKnownKeys(block, keys)) {
    markMentionScanIncomplete(state);
  }
  validateOptionalString(block.block_id, state);
  if (typeof block.task_id !== "string" || typeof block.title !== "string") {
    markMentionScanIncomplete(state);
  }
  if (block.status !== undefined && !TASK_STATUSES.has(String(block.status))) {
    markMentionScanIncomplete(state);
  }
  if (block.details !== undefined) {
    collectRichTextBlock(block.details, state);
  }
  if (block.output !== undefined) {
    collectRichTextBlock(block.output, state);
  }
  if (block.sources === undefined) {
    return;
  }
  if (!Array.isArray(block.sources)) {
    markMentionScanIncomplete(state);
    return;
  }
  for (const source of block.sources) {
    if (
      !isRecord(source) ||
      source.type !== "url" ||
      !hasOnlyKnownKeys(source, new Set(["type", "url", "text"])) ||
      typeof source.url !== "string" ||
      typeof source.text !== "string"
    ) {
      markMentionScanIncomplete(state);
    }
  }
}
