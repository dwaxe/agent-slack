import { describe, expect, test } from "bun:test";
import {
  canonicalizeSlackTextContent,
  canonicalSlackTextContentSha256,
} from "../src/slack/content-identity.ts";

describe("Slack content identity", () => {
  test.each([
    ["See https://example.com/path :rocket: &amp; go", "See <https://example.com/path> 🚀 & go"],
    ["Read https://docs.slack.dev", "Read <https://docs.slack.dev/|https://docs.slack.dev/>"],
    ["See https://example.com.", "See <https://example.com>."],
    ["See https://example.com/(foo)", "See <https://example.com/(foo)>"],
    ["Visit www.example.com/docs", "Visit <http://example.com/docs|www.example.com/docs>"],
    ["Email alice@example.com", "Email <mailto:alice@example.com|alice@example.com>"],
    ["Ask <@U12345678> in <#C12345678>", "Ask <@U12345678|Alice> in <#C12345678|team>"],
    ["Ask <!subteam^S12345678>", "Ask <!subteam^S12345678|reviewers>"],
  ])("matches outbound %s to Slack search form", (outbound, retrieved) => {
    expect(canonicalSlackTextContentSha256(outbound)).toBe(
      canonicalSlackTextContentSha256(retrieved),
    );
  });

  test("retains intentionally labeled links", () => {
    expect(canonicalizeSlackTextContent("See <https://example.com|the docs>")).toBe(
      "See [the docs](https://example.com)",
    );
  });

  test("does not truncate URLs containing balanced parentheses", () => {
    expect(canonicalizeSlackTextContent("See https://example.com/(foo)")).toBe(
      "See https://example.com/(foo)",
    );
  });
});
