import { describe, expect, test } from "bun:test";
import type { CliContext } from "../src/cli/context.ts";
import {
  handleMessageContext,
  handleMessageRevalidate,
  parseContextSnapshot,
} from "../src/cli/message-context.ts";

const target = "https://workspace.slack.com/archives/C12345678/p1700000000000001";

function buildContext(input?: { replyText?: string; reactions?: unknown[]; files?: unknown[] }) {
  const replyText = input?.replyText ?? "reply";
  const reactions = input?.reactions ?? [{ name: "eyes", users: ["U11111111"], count: 1 }];
  const files = input?.files ?? [];
  const root = {
    ts: "1700000000.000001",
    text: "root",
    user: "U11111111",
    reply_count: 1,
    reactions,
    files,
  };
  const reply = {
    ts: "1700000001.000002",
    thread_ts: root.ts,
    text: replyText,
    user: "U22222222",
  };
  const calls: string[] = [];
  const ctx = {
    withAutoRefresh: async (input: { work: () => Promise<unknown> }) => await input.work(),
    getClientForWorkspace: async () => ({
      workspace_url: "https://workspace.slack.com",
      auth: { auth_type: "standard", token: "test-token" },
      client: {
        api: async (method: string) => {
          calls.push(method);
          if (method === "conversations.replies") {
            return {
              messages: [reply, root],
              has_more: false,
              response_metadata: { next_cursor: "" },
            };
          }
          throw new Error(`Unexpected Slack method: ${method}`);
        },
      },
    }),
  } as unknown as CliContext;
  return { ctx, calls };
}

const options = { maxBodyChars: "8000", download: false, includeReactions: true };

describe("message context snapshots", () => {
  test("returns the focal message, complete ordered thread, and bound snapshot", async () => {
    const { ctx, calls } = buildContext();
    const payload = await handleMessageContext({ ctx, targetInput: target, options });

    expect(calls).toEqual(["conversations.replies"]);
    expect(payload).toMatchObject({
      workspace_url: "https://workspace.slack.com",
      channel_id: "C12345678",
      focal_ts: "1700000000.000001",
      thread_ts: "1700000000.000001",
      latest_ts: "1700000001.000002",
      message_count: 2,
      include_reactions: true,
      thread_complete: true,
    });
    expect(payload.messages).toEqual([
      expect.objectContaining({ ts: "1700000000.000001", content: "root" }),
      expect.objectContaining({ ts: "1700000001.000002", content: "reply" }),
    ]);
    expect(parseContextSnapshot(String(payload.snapshot))).toMatchObject({
      workspace_url: "https://workspace.slack.com",
      channel_id: "C12345678",
      focal_ts: "1700000000.000001",
      message_count: 2,
    });
  });

  test("returns a compact receipt when the complete thread is unchanged", async () => {
    const initial = await handleMessageContext({
      ctx: buildContext().ctx,
      targetInput: target,
      options,
    });
    const current = await handleMessageRevalidate({
      ctx: buildContext().ctx,
      targetInput: target,
      snapshot: String(initial.snapshot),
      options,
    });

    expect(current).toEqual({
      unchanged: true,
      snapshot: initial.snapshot,
      thread_ts: "1700000000.000001",
      latest_ts: "1700000001.000002",
      message_count: 2,
    });
    expect(current.messages).toBeUndefined();
  });

  test("uses a reply permalink's thread hint in one complete-thread read", async () => {
    const { ctx, calls } = buildContext();
    const payload = await handleMessageContext({
      ctx,
      targetInput:
        "https://workspace.slack.com/archives/C12345678/p1700000001000002?thread_ts=1700000000.000001&cid=C12345678",
      options,
    });

    expect(calls).toEqual(["conversations.replies"]);
    expect(payload).toMatchObject({
      focal_ts: "1700000001.000002",
      thread_ts: "1700000000.000001",
      message_count: 2,
    });
  });

  test("returns fresh complete context when message content changed", async () => {
    const initial = await handleMessageContext({
      ctx: buildContext().ctx,
      targetInput: target,
      options,
    });
    const current = await handleMessageRevalidate({
      ctx: buildContext({ replyText: "edited reply" }).ctx,
      targetInput: target,
      snapshot: String(initial.snapshot),
      options,
    });

    expect(current.unchanged).toBe(false);
    expect(current.thread_complete).toBe(true);
    expect(current.messages).toEqual([
      expect.objectContaining({ content: "root" }),
      expect.objectContaining({ content: "edited reply" }),
    ]);
  });

  test("detects reaction changes when the snapshot included reactions", async () => {
    const initial = await handleMessageContext({
      ctx: buildContext().ctx,
      targetInput: target,
      options,
    });
    const current = await handleMessageRevalidate({
      ctx: buildContext({
        reactions: [
          { name: "eyes", users: ["U11111111"], count: 1 },
          { name: "plus_two", users: ["U22222222"], count: 1 },
        ],
      }).ctx,
      targetInput: target,
      snapshot: String(initial.snapshot),
      options: { maxBodyChars: "8000" },
    });

    expect(current.unchanged).toBe(false);
    expect(current.messages).toEqual([
      expect.objectContaining({ reactions: expect.arrayContaining([expect.any(Object)]) }),
      expect.objectContaining({ content: "reply" }),
    ]);
  });

  test("ignores reaction changes when the snapshot omitted reactions", async () => {
    const withoutReactions = { maxBodyChars: "8000", download: false };
    const initial = await handleMessageContext({
      ctx: buildContext().ctx,
      targetInput: target,
      options: withoutReactions,
    });
    const current = await handleMessageRevalidate({
      ctx: buildContext({
        reactions: [
          { name: "eyes", users: ["U11111111"], count: 1 },
          { name: "plus_two", users: ["U22222222"], count: 1 },
        ],
      }).ctx,
      targetInput: target,
      snapshot: String(initial.snapshot),
      options: withoutReactions,
    });

    expect(current.unchanged).toBe(true);
  });

  test("ignores file metadata enrichment differences for the same attachment IDs", async () => {
    const initial = await handleMessageContext({
      ctx: buildContext({
        reactions: [],
        files: [{ id: "F11111111", name: "initial.txt", mimetype: "text/plain", mode: "snippet" }],
      }).ctx,
      targetInput: target,
      options: { maxBodyChars: "8000", download: false },
    });
    const current = await handleMessageRevalidate({
      ctx: buildContext({
        reactions: [],
        files: [
          { id: "F11111111", name: "enriched.txt", mimetype: "text/markdown", mode: "snippet" },
        ],
      }).ctx,
      targetInput: target,
      snapshot: String(initial.snapshot),
      options: { maxBodyChars: "8000" },
    });

    expect(current.unchanged).toBe(true);
  });

  test("rejects a snapshot for another message", async () => {
    const initial = await handleMessageContext({
      ctx: buildContext().ctx,
      targetInput: target,
      options,
    });
    await expect(
      handleMessageRevalidate({
        ctx: buildContext().ctx,
        targetInput: "https://workspace.slack.com/archives/C87654321/p1700000000000001",
        snapshot: String(initial.snapshot),
        options,
      }),
    ).rejects.toThrow("does not belong");
  });

  test("rejects invalid output bounds before Slack access", async () => {
    const { ctx, calls } = buildContext();
    await expect(
      handleMessageContext({
        ctx,
        targetInput: target,
        options: { maxBodyChars: "8000oops", download: false },
      }),
    ).rejects.toThrow("--max-body-chars must be -1 or a non-negative integer");
    expect(calls).toEqual([]);
  });
});
