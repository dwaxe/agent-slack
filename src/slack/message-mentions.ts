import { isRecord } from "../lib/object-type-guards.ts";
import { isUserId } from "./user-id.ts";

const USER_ID_PATTERN = /^[UW][A-Z0-9]{8,19}$/;
const USERGROUP_ID_PATTERN = /^S[A-Z0-9]{8,19}$/;
const USER_MENTION_PATTERN = /^<@([UW][A-Z0-9]{8,19})(?![A-Z0-9])(?:\|[^<>\r\n]{1,256})?>/;
const USERGROUP_MENTION_PATTERN =
  /^<!subteam\^(S[A-Z0-9]{8,19})(?![A-Z0-9])(?:\|[^<>\r\n]{1,256})?>/;
const BLOCKQUOTE_LINE_PATTERN = /^[\t ]*>/;
const MULTILINE_BLOCKQUOTE_LINE_PATTERN = /^[\t ]*>>>/;

type MentionAccumulator = {
  userIds: Set<string>;
  usergroupIds: Set<string>;
};

type MrkdwnScanState = {
  accumulator: MentionAccumulator;
  inFence: boolean;
  inMultilineQuote: boolean;
};

export type MentionEvidence = {
  schema: 1;
  user_ids: string[];
  usergroup_ids: string[];
};

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isUsergroupId(value: string): boolean {
  return USERGROUP_ID_PATTERN.test(value);
}

function isMentionUserId(value: string): boolean {
  return USER_ID_PATTERN.test(value) && isUserId(value);
}

function isEscaped(text: string, index: number): boolean {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    backslashCount++;
  }
  return backslashCount % 2 === 1;
}

function collectMrkdwnLine(line: string, state: MrkdwnScanState): void {
  if (!state.inFence && MULTILINE_BLOCKQUOTE_LINE_PATTERN.test(line)) {
    state.inMultilineQuote = true;
  }
  if (!state.inFence && (state.inMultilineQuote || BLOCKQUOTE_LINE_PATTERN.test(line))) {
    return;
  }

  let inInlineCode = false;
  for (let index = 0; index < line.length; ) {
    if (line.startsWith("```", index) && !isEscaped(line, index) && !inInlineCode) {
      state.inFence = !state.inFence;
      index += 3;
      continue;
    }
    if (state.inFence) {
      index++;
      continue;
    }
    if (line[index] === "`" && !isEscaped(line, index)) {
      inInlineCode = !inInlineCode;
      index++;
      continue;
    }
    if (inInlineCode || line[index] !== "<" || isEscaped(line, index)) {
      index++;
      continue;
    }

    const remainder = line.slice(index);
    const userMatch = USER_MENTION_PATTERN.exec(remainder);
    const userId = userMatch?.[1];
    if (userMatch && userId && isMentionUserId(userId)) {
      state.accumulator.userIds.add(userId);
      index += userMatch[0].length;
      continue;
    }
    const usergroupMatch = USERGROUP_MENTION_PATTERN.exec(remainder);
    const usergroupId = usergroupMatch?.[1];
    if (usergroupMatch && usergroupId && isUsergroupId(usergroupId)) {
      state.accumulator.usergroupIds.add(usergroupId);
      index += usergroupMatch[0].length;
      continue;
    }
    index++;
  }
}

function collectMrkdwn(text: string, accumulator: MentionAccumulator): void {
  const state: MrkdwnScanState = {
    accumulator,
    inFence: false,
    inMultilineQuote: false,
  };
  for (const line of text.split(/\r?\n/)) {
    collectMrkdwnLine(line, state);
  }
}

function collectSemanticRichTextElement(value: unknown, accumulator: MentionAccumulator): void {
  if (!isRecord(value)) {
    return;
  }
  const type = getString(value.type);
  if (type === "user") {
    const userId = getString(value.user_id);
    if (isMentionUserId(userId)) {
      accumulator.userIds.add(userId);
    }
    return;
  }
  if (type === "usergroup") {
    const usergroupId = getString(value.usergroup_id);
    if (isUsergroupId(usergroupId)) {
      accumulator.usergroupIds.add(usergroupId);
    }
    return;
  }
  if (type !== "rich_text_section" && type !== "rich_text_list") {
    return;
  }
  const elements = Array.isArray(value.elements) ? value.elements : [];
  for (const element of elements) {
    collectSemanticRichTextElement(element, accumulator);
  }
}

function collectRichTextBlock(
  value: Record<string, unknown>,
  accumulator: MentionAccumulator,
): void {
  const elements = Array.isArray(value.elements) ? value.elements : [];
  for (const element of elements) {
    if (!isRecord(element)) {
      continue;
    }
    const type = getString(element.type);
    if (type === "rich_text_section" || type === "rich_text_list") {
      collectSemanticRichTextElement(element, accumulator);
    }
  }
}

function collectMrkdwnObject(value: unknown, accumulator: MentionAccumulator): void {
  if (!isRecord(value) || value.type !== "mrkdwn") {
    return;
  }
  const text = getString(value.text);
  if (text) {
    collectMrkdwn(text, accumulator);
  }
}

function collectTopLevelBlocks(blocks: unknown, accumulator: MentionAccumulator): void {
  if (!Array.isArray(blocks)) {
    return;
  }
  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }
    const type = getString(block.type);
    if (type === "rich_text") {
      collectRichTextBlock(block, accumulator);
      continue;
    }
    if (type === "section") {
      collectMrkdwnObject(block.text, accumulator);
      const fields = Array.isArray(block.fields) ? block.fields : [];
      for (const field of fields) {
        collectMrkdwnObject(field, accumulator);
      }
      continue;
    }
    if (type === "context") {
      const elements = Array.isArray(block.elements) ? block.elements : [];
      for (const element of elements) {
        collectMrkdwnObject(element, accumulator);
      }
    }
  }
}

export function collectDirectMessageMentions(input: {
  text?: string;
  blocks?: unknown[];
}): MentionEvidence {
  const accumulator: MentionAccumulator = {
    userIds: new Set<string>(),
    usergroupIds: new Set<string>(),
  };
  if (typeof input.text === "string") {
    collectMrkdwn(input.text, accumulator);
  }
  collectTopLevelBlocks(input.blocks, accumulator);

  return {
    schema: 1,
    user_ids: Array.from(accumulator.userIds).sort(),
    usergroup_ids: Array.from(accumulator.usergroupIds).sort(),
  };
}
