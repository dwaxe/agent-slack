import { createHash } from "node:crypto";
import { slackMrkdwnToMarkdown } from "./mrkdwn.ts";

/**
 * Normalize the Slack text representations that can change between a write and
 * a later search result. This deliberately uses the same conversion for both
 * sides of provenance matching so URL wrappers, HTML entities, and standard
 * emoji shortcodes do not change message identity.
 */
export function canonicalizeSlackTextContent(text: string): string {
  const normalizedAutolinks = text
    // Slack search can add display labels to identity tokens. Hash stable IDs,
    // not mutable display names.
    .replace(/<@([UWB][A-Z0-9]+)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<#([CG][A-Z0-9]+)(?:\|[^>]*)?>/g, "#$1")
    .replace(/<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g, "@subteam^$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    // Slack autolinks bare email addresses on storage/search.
    .replace(/<mailto:([^>|]+)(?:\|([^>]+))?>/gi, (token, address, label) =>
      label === undefined || label.toLowerCase() === address.toLowerCase() ? address : token,
    )
    // A scheme-less domain can come back as <http://host|www.host>. Collapse
    // URL-like display labels so it matches the original outbound text.
    .replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/gi, (token, url, label) => {
      if (isSchemeLessUrlLabel(label)) {
        return label;
      }
      return areEquivalentHttpUrls(url, label) ? normalizeHttpUrl(url) : token;
    });
  return slackMrkdwnToMarkdown(normalizedAutolinks)
    .replace(/https?:\/\/[^\s<>]+/gi, (url) => normalizeBareHttpUrl(url))
    .trim();
}

export function slackTextContentSha256(text: string): string {
  return sha256(text);
}

export function canonicalSlackTextContentSha256(text: string): string {
  return sha256(canonicalizeSlackTextContent(text));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isSchemeLessUrlLabel(value: string): boolean {
  return /^(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s]*)?$/i.test(
    value,
  );
}

function areEquivalentHttpUrls(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

function normalizeHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname === "/" && !url.search && !url.hash ? url.origin : url.href;
  } catch {
    return value;
  }
}

function normalizeBareHttpUrl(value: string): string {
  const { url, trailing } = splitTrailingProsePunctuation(value);
  try {
    const parsed = new URL(url);
    const normalized =
      parsed.pathname === "/" && !parsed.search && !parsed.hash ? parsed.origin : url;
    return `${normalized}${trailing}`;
  } catch {
    return value;
  }
}

function splitTrailingProsePunctuation(value: string): { url: string; trailing: string } {
  let url = value;
  let trailing = "";
  while (url) {
    const last = url.at(-1)!;
    if (/[.,!?;:'"]/.test(last)) {
      url = url.slice(0, -1);
      trailing = `${last}${trailing}`;
      continue;
    }
    const opener = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : undefined;
    if (!opener || countCharacter(url, last) <= countCharacter(url, opener)) {
      break;
    }
    url = url.slice(0, -1);
    trailing = `${last}${trailing}`;
  }
  return { url, trailing };
}

function countCharacter(value: string, character: string): number {
  return [...value].filter((candidate) => candidate === character).length;
}
