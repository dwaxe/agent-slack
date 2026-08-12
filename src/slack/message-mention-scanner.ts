import { isRecord } from "../lib/object-type-guards.ts";
import { isUserId } from "./user-id.ts";

const USER_ID_PATTERN = /^[UW][A-Z0-9]{8,19}$/;
const USERGROUP_ID_PATTERN = /^S[A-Z0-9]{8,19}$/;
const USER_MENTION_PATTERN = /^<@([UW][A-Z0-9]{8,19})(?![A-Z0-9])(?:\|[^<>\r\n]{1,256})?>/;
const USERGROUP_MENTION_PATTERN =
  /^<!subteam\^(S[A-Z0-9]{8,19})(?![A-Z0-9])(?:\|[^<>\r\n]{1,256})?>/;
const BLOCKQUOTE_LINE_PATTERN = /^[\t ]*>/;
const MULTILINE_BLOCKQUOTE_LINE_PATTERN = /^[\t ]*>>>/;
const RICH_TEXT_STYLE_KEYS = new Set(["bold", "code", "italic", "strike", "underline"]);
const RICH_TEXT_LEAF_KEYS: Record<string, ReadonlySet<string>> = {
  broadcast: new Set(["type", "range", "style"]),
  channel: new Set(["type", "channel_id", "style"]),
  color: new Set(["type", "value", "style"]),
  date: new Set(["type", "timestamp", "format", "url", "fallback", "style"]),
  emoji: new Set(["type", "name", "unicode", "url", "style"]),
  link: new Set(["type", "url", "text", "unsafe", "style"]),
  team: new Set(["type", "team_id", "style"]),
  text: new Set(["type", "text", "style"]),
  user: new Set(["type", "user_id", "style"]),
  usergroup: new Set(["type", "usergroup_id", "style"]),
};

export type MentionScanState = {
  complete: boolean;
  userIds: Set<string>;
  usergroupIds: Set<string>;
};

type MrkdwnScanState = {
  mentions: MentionScanState;
  inFence: boolean;
  inMultilineQuote: boolean;
};

export function markMentionScanIncomplete(state: MentionScanState): void {
  state.complete = false;
}

function hasOnlyKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function validateOptionalString(value: unknown, state: MentionScanState): void {
  if (value !== undefined && typeof value !== "string") {
    markMentionScanIncomplete(state);
  }
}

function validateRichTextStyle(value: unknown, state: MentionScanState): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    markMentionScanIncomplete(state);
    return;
  }
  if (!hasOnlyKnownKeys(value, RICH_TEXT_STYLE_KEYS)) {
    markMentionScanIncomplete(state);
  }
  if (Object.values(value).some((property) => typeof property !== "boolean")) {
    markMentionScanIncomplete(state);
  }
}

function isMentionUserId(value: string): boolean {
  return USER_ID_PATTERN.test(value) && isUserId(value);
}

function isUsergroupId(value: string): boolean {
  return USERGROUP_ID_PATTERN.test(value);
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
      state.mentions.userIds.add(userId);
      index += userMatch[0].length;
      continue;
    }
    const usergroupMatch = USERGROUP_MENTION_PATTERN.exec(remainder);
    const usergroupId = usergroupMatch?.[1];
    if (usergroupMatch && usergroupId && isUsergroupId(usergroupId)) {
      state.mentions.usergroupIds.add(usergroupId);
      index += usergroupMatch[0].length;
      continue;
    }
    index++;
  }
}

export function collectMrkdwnMentions(text: string, mentions: MentionScanState): void {
  const state: MrkdwnScanState = {
    mentions,
    inFence: false,
    inMultilineQuote: false,
  };
  for (const line of text.split(/\r?\n/)) {
    collectMrkdwnLine(line, state);
  }
}

function collectRichTextInlineElement(
  value: unknown,
  input: { state: MentionScanState; includeMentions: boolean },
): void {
  const { state, includeMentions } = input;
  if (!isRecord(value) || typeof value.type !== "string") {
    markMentionScanIncomplete(state);
    return;
  }
  const knownKeys = RICH_TEXT_LEAF_KEYS[value.type];
  if (!knownKeys) {
    markMentionScanIncomplete(state);
    return;
  }
  if (!hasOnlyKnownKeys(value, knownKeys)) {
    markMentionScanIncomplete(state);
  }
  validateRichTextStyle(value.style, state);
  if (value.type === "user") {
    const userId = typeof value.user_id === "string" ? value.user_id : "";
    if (isMentionUserId(userId)) {
      if (includeMentions) {
        state.userIds.add(userId);
      }
    } else {
      markMentionScanIncomplete(state);
    }
    return;
  }
  if (value.type === "usergroup") {
    const usergroupId = typeof value.usergroup_id === "string" ? value.usergroup_id : "";
    if (isUsergroupId(usergroupId)) {
      if (includeMentions) {
        state.usergroupIds.add(usergroupId);
      }
    } else {
      markMentionScanIncomplete(state);
    }
    return;
  }

  if (value.type === "broadcast") {
    if (value.range !== "here" && value.range !== "channel" && value.range !== "everyone") {
      markMentionScanIncomplete(state);
    }
  } else if (value.type === "channel") {
    if (typeof value.channel_id !== "string") {
      markMentionScanIncomplete(state);
    }
  } else if (value.type === "color") {
    if (typeof value.value !== "string") {
      markMentionScanIncomplete(state);
    }
  } else if (value.type === "date") {
    if (typeof value.timestamp !== "number" || typeof value.format !== "string") {
      markMentionScanIncomplete(state);
    }
    validateOptionalString(value.url, state);
    validateOptionalString(value.fallback, state);
  } else if (value.type === "emoji") {
    if (typeof value.name !== "string") {
      markMentionScanIncomplete(state);
    }
    validateOptionalString(value.unicode, state);
    validateOptionalString(value.url, state);
  } else if (value.type === "link") {
    if (typeof value.url !== "string") {
      markMentionScanIncomplete(state);
    }
    validateOptionalString(value.text, state);
    if (value.unsafe !== undefined && typeof value.unsafe !== "boolean") {
      markMentionScanIncomplete(state);
    }
  } else if (value.type === "team") {
    if (typeof value.team_id !== "string") {
      markMentionScanIncomplete(state);
    }
  } else if (value.type === "text" && typeof value.text !== "string") {
    markMentionScanIncomplete(state);
  }
}

function collectRichTextSection(
  value: Record<string, unknown>,
  input: { state: MentionScanState; includeMentions: boolean },
): void {
  const { state } = input;
  if (!hasOnlyKnownKeys(value, new Set(["type", "elements"]))) {
    markMentionScanIncomplete(state);
  }
  if (!Array.isArray(value.elements)) {
    markMentionScanIncomplete(state);
    return;
  }
  for (const element of value.elements) {
    collectRichTextInlineElement(element, input);
  }
}

function collectRichTextList(value: Record<string, unknown>, state: MentionScanState): void {
  if (!hasOnlyKnownKeys(value, new Set(["type", "elements", "style", "indent", "border"]))) {
    markMentionScanIncomplete(state);
  }
  if (value.style !== "bullet" && value.style !== "ordered") {
    markMentionScanIncomplete(state);
  }
  if (value.indent !== undefined && typeof value.indent !== "number") {
    markMentionScanIncomplete(state);
  }
  if (value.border !== undefined && value.border !== 0 && value.border !== 1) {
    markMentionScanIncomplete(state);
  }
  if (!Array.isArray(value.elements)) {
    markMentionScanIncomplete(state);
    return;
  }
  for (const element of value.elements) {
    if (!isRecord(element) || element.type !== "rich_text_section") {
      markMentionScanIncomplete(state);
      continue;
    }
    collectRichTextSection(element, { state, includeMentions: true });
  }
}

function collectExcludedRichTextContainer(
  value: Record<string, unknown>,
  state: MentionScanState,
): void {
  if (!hasOnlyKnownKeys(value, new Set(["type", "elements", "border"]))) {
    markMentionScanIncomplete(state);
  }
  if (value.border !== undefined && value.border !== 0 && value.border !== 1) {
    markMentionScanIncomplete(state);
  }
  if (!Array.isArray(value.elements)) {
    markMentionScanIncomplete(state);
    return;
  }
  for (const element of value.elements) {
    collectRichTextInlineElement(element, { state, includeMentions: false });
  }
}

export function collectRichTextBlock(value: unknown, state: MentionScanState): void {
  if (!isRecord(value) || value.type !== "rich_text" || !Array.isArray(value.elements)) {
    markMentionScanIncomplete(state);
    return;
  }
  if (!hasOnlyKnownKeys(value, new Set(["type", "elements", "block_id"]))) {
    markMentionScanIncomplete(state);
  }
  validateOptionalString(value.block_id, state);
  for (const element of value.elements) {
    if (!isRecord(element) || typeof element.type !== "string") {
      markMentionScanIncomplete(state);
      continue;
    }
    if (element.type === "rich_text_section") {
      collectRichTextSection(element, { state, includeMentions: true });
    } else if (element.type === "rich_text_list") {
      collectRichTextList(element, state);
    } else if (element.type === "rich_text_quote" || element.type === "rich_text_preformatted") {
      collectExcludedRichTextContainer(element, state);
    } else {
      markMentionScanIncomplete(state);
    }
  }
}

export function collectTextObjectMentions(value: unknown, state: MentionScanState): void {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.text !== "string") {
    markMentionScanIncomplete(state);
    return;
  }
  if (!hasOnlyKnownKeys(value, new Set(["type", "text", "emoji", "verbatim"]))) {
    markMentionScanIncomplete(state);
  }
  if (value.emoji !== undefined && typeof value.emoji !== "boolean") {
    markMentionScanIncomplete(state);
  }
  if (value.verbatim !== undefined && typeof value.verbatim !== "boolean") {
    markMentionScanIncomplete(state);
  }
  if (value.type === "mrkdwn") {
    collectMrkdwnMentions(value.text, state);
  } else if (value.type !== "plain_text") {
    markMentionScanIncomplete(state);
  }
}
