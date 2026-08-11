import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../src/cli/context.ts";
import { editMessage, sendMessage } from "../src/cli/message-actions.ts";
import {
  cancelScheduledMessage,
  listScheduledMessages,
} from "../src/cli/message-scheduled-actions.ts";
import {
  findScheduledMessageReceiptIdentity,
  parseAbsoluteSchedule,
  parseRelativeSchedule,
  resolveSchedulePostAt,
} from "../src/slack/scheduled-messages.ts";

const TEST_CREDENTIAL_FINGERPRINT = "f".repeat(64);

function createContext(calls: { method: string; params: Record<string, unknown> }[]) {
  const client = {
    credentialFingerprint: () => TEST_CREDENTIAL_FINGERPRINT,
    api: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "auth.test") {
        return {
          ok: true,
          url: "https://workspace.slack.com/",
          team_id: "T12345678",
          user_id: "U12345678",
        };
      }
      if (method === "files.getUploadURLExternal") {
        return { ok: true, upload_url: "https://upload.example/file", file_id: "F123" };
      }
      if (method === "files.completeUploadExternal") {
        const channelId = String(params.channel_id);
        return {
          ok: true,
          files: [
            {
              id: "F123",
              shares: { public: { [channelId]: [{ ts: "1770165109.628379" }] } },
            },
          ],
        };
      }
      if (method === "chat.postMessage") {
        return { ok: true, channel: String(params.channel), ts: "1770165109.628379" };
      }
      if (method === "chat.scheduleMessage") {
        return {
          ok: true,
          channel: String(params.channel),
          scheduled_message_id: "Q1234ABCD",
          post_at: String(params.post_at),
        };
      }
      if (method === "chat.scheduledMessages.list") {
        if (params.cursor === "next-1") {
          return {
            ok: true,
            scheduled_messages: [],
            response_metadata: { next_cursor: "" },
          };
        }
        return {
          ok: true,
          scheduled_messages: [
            {
              id: "Q1234ABCD",
              channel_id: String(params.channel ?? "C12345678"),
              post_at: 1770168709,
              text: "scheduled",
            },
          ],
          response_metadata: { next_cursor: "next-1" },
        };
      }
      if (method === "chat.deleteScheduledMessage") {
        return { ok: true };
      }
      if (method === "search.messages") {
        return {
          ok: true,
          messages: { matches: [{ channel: { id: "C12345678", name: "general" } }] },
        };
      }
      if (method === "conversations.open") {
        return { ok: true, channel: { id: "D12345678" } };
      }
      return { ok: true };
    },
  };

  return {
    effectiveWorkspaceUrl: (flag?: string) => flag,
    assertWorkspaceSpecifiedForChannelNames: async () => {},
    withAutoRefresh: async <T>(input: {
      workspaceUrl: string | undefined;
      work: () => Promise<T>;
    }) => input.work(),
    getClientForWorkspace: async () => ({
      client: client as never,
      auth: { auth_type: "standard", token: "x" as const },
      workspace_url: "https://workspace.slack.com",
    }),
    normalizeUrl: (u: string) => u,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    parseContentType: () => "any",
    parseCurl: () => ({
      workspace_url: "https://workspace.slack.com",
      xoxc_token: "xoxc-1",
      xoxd_cookie: "xoxd-1",
    }),
    importDesktop: async () => ({
      cookie_d: "",
      teams: [],
      source: { leveldb_path: "", cookies_path: "" },
    }),
    importChrome: () => ({ cookie_d: "", teams: [] }),
    importBrave: async () => null,
    importFirefox: async () => null,
  } satisfies CliContext;
}

function receiptLifecycle(
  events: { phase: string; input: Record<string, unknown> }[],
  options: { finalizeError?: Error; reserveError?: Error } = {},
): Pick<CliContext, "reserveSendReceipt" | "finalizeSendReceipt" | "cancelSendReceipt"> {
  let intentCounter = 0;
  return {
    reserveSendReceipt: async (input) => {
      events.push({ phase: "reserve", input });
      if (options.reserveError) {
        throw options.reserveError;
      }
      intentCounter += 1;
      return {
        intent_id: `intent-${intentCounter}`,
        workspace_url: input.workspaceUrl,
        channel_id: input.channelId,
        ts: input.ts,
        thread_ts: input.threadTs,
        action: input.action,
        content_sha256: "a".repeat(64),
        post_at: input.postAt,
        reserved_at: "2026-08-11T18:00:00.000Z",
      };
    },
    finalizeSendReceipt: async (input) => {
      events.push({ phase: "finalize", input });
      if (options.finalizeError) {
        throw options.finalizeError;
      }
      return {} as never;
    },
    cancelSendReceipt: async (input) => {
      events.push({ phase: "cancel", input });
    },
  };
}

describe("sendMessage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("posts a normal message when no attachments are passed", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    const result = await sendMessage({
      ctx,
      targetInput: "C12345678",
      text: "hello",
      options: { workspace: "https://workspace.slack.com" },
    });

    expect(calls).toEqual([
      {
        method: "chat.postMessage",
        params: {
          channel: "C12345678",
          text: "hello",
          thread_ts: undefined,
        },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      channel_id: "C12345678",
      ts: "1770165109.628379",
      thread_ts: undefined,
      permalink: "https://workspace.slack.com/archives/C12345678/p1770165109628379",
    });
  });

  test("records a receipt only after a successful send", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const ctx: CliContext = {
      ...createContext(calls),
      ...receiptLifecycle(receiptEvents),
    };

    const result = await sendMessage({
      ctx,
      targetInput: "C12345678",
      text: "please use <fix>",
      options: {},
    });

    expect(result.receipt_recorded).toBe(true);
    expect(receiptEvents).toEqual([
      {
        phase: "reserve",
        input: {
          workspaceUrl: "https://workspace.slack.com",
          channelId: "C12345678",
          credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
          ts: undefined,
          threadTs: undefined,
          action: "send",
          content: "please use &lt;fix&gt;",
          postAt: undefined,
        },
      },
      {
        phase: "finalize",
        input: {
          intentId: "intent-1",
          ts: "1770165109.628379",
          scheduledMessageId: undefined,
          threadTs: undefined,
        },
      },
    ]);
  });

  test("discovers the exact workspace for token-only provenance before sending", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const base = createContext(calls);
    const ctx: CliContext = {
      ...base,
      getClientForWorkspace: async () => {
        const resolved = await base.getClientForWorkspace();
        return { ...resolved, workspace_url: undefined };
      },
      ...receiptLifecycle(receiptEvents),
    };

    const result = await sendMessage({
      ctx,
      targetInput: "C12345678",
      text: "token only",
      options: {},
    });

    expect(calls.map((call) => call.method)).toEqual(["auth.test", "chat.postMessage"]);
    expect(receiptEvents[0]?.input.workspaceUrl).toBe("https://workspace.slack.com");
    expect(result.receipt_recorded).toBe(true);
  });

  test("rejects a mismatched authenticated workspace before reserve or send", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const base = createContext(calls);
    const ctx: CliContext = {
      ...base,
      getClientForWorkspace: async () => {
        const resolved = await base.getClientForWorkspace();
        return { ...resolved, workspace_url: "https://other.slack.com" };
      },
      ...receiptLifecycle(receiptEvents),
    };

    await expect(
      sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "wrong workspace",
        options: { workspace: "https://other.slack.com" },
      }),
    ).rejects.toThrow(/authenticate to https:\/\/workspace\.slack\.com, not requested workspace/);
    expect(calls).toEqual([{ method: "auth.test", params: {} }]);
    expect(receiptEvents).toEqual([]);
  });

  test("reports receipt failure without retrying or failing a successful send", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const ctx: CliContext = {
      ...createContext(calls),
      ...receiptLifecycle(receiptEvents, { finalizeError: new Error("disk full") }),
    };
    const warning = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "hello",
        options: {},
      });

      expect(result.ok).toBe(true);
      expect(result.receipt_recorded).toBe(false);
      expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("mutation succeeded"));
      expect(receiptEvents.map((event) => event.phase)).toEqual(["reserve", "finalize"]);
    } finally {
      warning.mockRestore();
    }
  });

  test("does not record a receipt when Slack rejects the send", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const base = createContext(calls);
    const ctx: CliContext = {
      ...base,
      getClientForWorkspace: async () => ({
        client: {
          credentialFingerprint: () => TEST_CREDENTIAL_FINGERPRINT,
          api: async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params });
            if (method === "auth.test") {
              return {
                ok: true,
                url: "https://workspace.slack.com/",
                team_id: "T12345678",
                user_id: "U12345678",
              };
            }
            throw new Error("channel_not_found");
          },
        } as never,
        auth: { auth_type: "standard", token: "x" as const },
        workspace_url: "https://workspace.slack.com",
      }),
      ...receiptLifecycle(receiptEvents),
    };

    await expect(
      sendMessage({ ctx, targetInput: "C12345678", text: "hello", options: {} }),
    ).rejects.toThrow("channel_not_found");
    expect(receiptEvents.map((event) => event.phase)).toEqual(["reserve", "cancel"]);
  });

  test.each(["Slack HTTP 500 calling chat.postMessage", "internal_error"])(
    "retains the intent when Slack outcome is ambiguous: %s",
    async (message) => {
      const calls: { method: string; params: Record<string, unknown> }[] = [];
      const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
      const base = createContext(calls);
      const ctx: CliContext = {
        ...base,
        getClientForWorkspace: async () => ({
          client: {
            credentialFingerprint: () => TEST_CREDENTIAL_FINGERPRINT,
            api: async (method: string, params: Record<string, unknown>) => {
              calls.push({ method, params });
              if (method === "auth.test") {
                return {
                  ok: true,
                  url: "https://workspace.slack.com/",
                  team_id: "T12345678",
                  user_id: "U12345678",
                };
              }
              throw new Error(message);
            },
          } as never,
          auth: { auth_type: "standard", token: "x" as const },
          workspace_url: "https://workspace.slack.com",
        }),
        ...receiptLifecycle(receiptEvents),
      };
      const warning = spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await expect(
          sendMessage({ ctx, targetInput: "C12345678", text: "hello", options: {} }),
        ).rejects.toThrow(message);
        expect(receiptEvents.map((event) => event.phase)).toEqual(["reserve"]);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("outcome is unknown"));
      } finally {
        warning.mockRestore();
      }
    },
  );

  test("aborts before Slack when the durable intent reservation fails", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const ctx: CliContext = {
      ...createContext(calls),
      ...receiptLifecycle(receiptEvents, { reserveError: new Error("state unavailable") }),
    };

    await expect(
      sendMessage({ ctx, targetInput: "C12345678", text: "hello", options: {} }),
    ).rejects.toThrow("state unavailable");
    expect(calls).toEqual([{ method: "auth.test", params: {} }]);
    expect(receiptEvents.map((event) => event.phase)).toEqual(["reserve"]);
  });

  test("opens and sends to a DM for a W-prefixed user target", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await sendMessage({
      ctx,
      targetInput: "W12345678",
      text: "hello",
      options: {},
    });

    expect(calls).toEqual([
      {
        method: "conversations.open",
        params: { users: "W12345678" },
      },
      {
        method: "chat.postMessage",
        params: {
          channel: "D12345678",
          text: "hello",
          thread_ts: undefined,
        },
      },
    ]);
  });

  test("returns a permalink when the workspace was resolved implicitly", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    const result = await sendMessage({
      ctx,
      targetInput: "C12345678",
      text: "hello",
      options: {},
    });

    expect(calls).toEqual([
      {
        method: "chat.postMessage",
        params: {
          channel: "C12345678",
          text: "hello",
          thread_ts: undefined,
        },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      channel_id: "C12345678",
      ts: "1770165109.628379",
      thread_ts: undefined,
      permalink: "https://workspace.slack.com/archives/C12345678/p1770165109628379",
    });
  });

  test("threaded reply returns thread_ts distinct from ts", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    const result = await sendMessage({
      ctx,
      targetInput: "C12345678",
      text: "reply",
      options: { threadTs: "1770160000.000001" },
    });

    expect(result).toEqual({
      ok: true,
      channel_id: "C12345678",
      ts: "1770165109.628379",
      thread_ts: "1770160000.000001",
      permalink:
        "https://workspace.slack.com/archives/C12345678/p1770165109628379?thread_ts=1770160000.000001&cid=C12345678",
    });
  });

  test("--reply-broadcast with --thread-ts sends reply_broadcast: true", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await sendMessage({
      ctx,
      targetInput: "C12345678",
      text: "shipping today",
      options: { threadTs: "1770160000.000001", replyBroadcast: true },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.postMessage");
    expect(calls[0]?.params.reply_broadcast).toBe(true);
    expect(calls[0]?.params.thread_ts).toBe("1770160000.000001");
  });

  test("--reply-broadcast omits the field from chat.postMessage when flag is absent", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await sendMessage({
      ctx,
      targetInput: "C12345678",
      text: "reply",
      options: { threadTs: "1770160000.000001" },
    });

    expect(calls).toHaveLength(1);
    expect("reply_broadcast" in (calls[0]?.params ?? {})).toBe(false);
  });

  test("--reply-broadcast without --thread-ts throws", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await expect(
      sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "oops",
        options: { replyBroadcast: true },
      }),
    ).rejects.toThrow(/--reply-broadcast requires --thread-ts/);

    expect(calls).toHaveLength(0);
  });

  test("--reply-broadcast on a URL target broadcasts using the message's derived thread_ts", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx: CliContext = {
      ...createContext(calls),
      getClientForWorkspace: async () => ({
        client: {
          api: async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params });
            if (method === "conversations.history") {
              return {
                ok: true,
                messages: [
                  { ts: "1770160500.000100", thread_ts: "1770160000.000001", text: "root" },
                ],
              };
            }
            if (method === "chat.postMessage") {
              return { ok: true, channel: String(params.channel), ts: "1770165109.628379" };
            }
            return { ok: true };
          },
        } as never,
        auth: { auth_type: "standard", token: "x" as const },
        workspace_url: "https://workspace.slack.com",
      }),
    };

    await sendMessage({
      ctx,
      targetInput: "https://workspace.slack.com/archives/C12345678/p1770160500000100",
      text: "broadcast",
      options: { replyBroadcast: true },
    });

    const post = calls.find((c) => c.method === "chat.postMessage");
    expect(post).toBeDefined();
    expect(post?.params.reply_broadcast).toBe(true);
    expect(post?.params.thread_ts).toBe("1770160000.000001");
  });

  test("--reply-broadcast on a DM target throws (broadcasting is not meaningful for DMs)", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await expect(
      sendMessage({
        ctx,
        targetInput: "U05BRPTKL6A",
        text: "hi",
        options: { threadTs: "1770160000.000001", replyBroadcast: true },
      }),
    ).rejects.toThrow(/--reply-broadcast is not supported for DM targets/);

    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(false);
    expect(calls.some((c) => c.method === "conversations.open")).toBe(false);
  });

  test("--reply-broadcast works alongside --blocks payload", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const blocksPath = join(dir, "blocks.json");
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "summary" } }];
    await writeFile(blocksPath, JSON.stringify(blocks));

    try {
      await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "fallback",
        options: {
          threadTs: "1770160000.000001",
          replyBroadcast: true,
          blocks: blocksPath,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.postMessage");
    expect(calls[0]?.params).toEqual({
      channel: "C12345678",
      text: "fallback",
      thread_ts: "1770160000.000001",
      blocks,
      reply_broadcast: true,
    });
  });

  test("uploads attachment and uses message text as initial comment", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const filePath = join(dir, "report.md");
    await writeFile(filePath, "# report\n");

    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "here's the report",
        options: { attach: [filePath] },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls[0]?.method).toBe("files.getUploadURLExternal");
    expect(calls[1]?.method).toBe("files.completeUploadExternal");
    expect(calls[1]?.params.initial_comment).toBe("here's the report");
    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("records the attachment initial comment with its returned share identity", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const ctx: CliContext = {
      ...createContext(calls),
      ...receiptLifecycle(receiptEvents),
    };
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const filePath = join(dir, "report.md");
    await writeFile(filePath, "# report\n");
    globalThis.fetch = mock(
      async () => new Response("", { status: 200 }),
    ) as unknown as typeof fetch;

    try {
      const result = await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "here's the report",
        options: { attach: [filePath] },
      });

      expect(result.ts).toBe("1770165109.628379");
      expect(result.receipt_recorded).toBe(true);
      expect(receiptEvents).toEqual([
        {
          phase: "reserve",
          input: {
            workspaceUrl: "https://workspace.slack.com",
            channelId: "C12345678",
            credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
            threadTs: undefined,
            action: "attachment_send",
            content: "here's the report",
            postAt: undefined,
          },
        },
        {
          phase: "finalize",
          input: {
            intentId: "intent-1",
            ts: "1770165109.628379",
            scheduledMessageId: undefined,
            threadTs: undefined,
          },
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not reserve an attachment intent when the local file is missing", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const ctx: CliContext = {
      ...createContext(calls),
      ...receiptLifecycle(receiptEvents),
    };

    await expect(
      sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "missing attachment",
        options: { attach: ["/definitely/missing/agent-slack-file"] },
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(receiptEvents).toEqual([]);
  });

  test("does not reserve an attachment intent when the byte upload fails", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const ctx: CliContext = {
      ...createContext(calls),
      ...receiptLifecycle(receiptEvents),
    };
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const filePath = join(dir, "report.md");
    await writeFile(filePath, "# report\n");
    globalThis.fetch = mock(
      async () => new Response("upload failed", { status: 500 }),
    ) as unknown as typeof fetch;

    try {
      await expect(
        sendMessage({
          ctx,
          targetInput: "C12345678",
          text: "failed attachment",
          options: { attach: [filePath] },
        }),
      ).rejects.toThrow(/Failed to upload attachment bytes/);
      expect(calls.map((call) => call.method)).toEqual(["auth.test", "files.getUploadURLExternal"]);
      expect(receiptEvents).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a mismatched workspace before uploading attachment bytes", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const base = createContext(calls);
    const ctx: CliContext = {
      ...base,
      getClientForWorkspace: async () => {
        const resolved = await base.getClientForWorkspace();
        return { ...resolved, workspace_url: "https://other.slack.com" };
      },
      ...receiptLifecycle(receiptEvents),
    };
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const filePath = join(dir, "report.md");
    await writeFile(filePath, "# report\n");
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        sendMessage({
          ctx,
          targetInput: "C12345678",
          text: "wrong workspace attachment",
          options: { attach: [filePath] },
        }),
      ).rejects.toThrow(/authenticate to https:\/\/workspace\.slack\.com/);
      expect(calls).toEqual([{ method: "auth.test", params: {} }]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(receiptEvents).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sends initial comment only for the first attachment", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const first = join(dir, "report.md");
    const second = join(dir, "log.txt");
    await writeFile(first, "# report\n");
    await writeFile(second, "ok\n");

    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "see files",
        options: { attach: [first, second] },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const completes = calls.filter((c) => c.method === "files.completeUploadExternal");
    expect(completes).toHaveLength(2);
    expect(completes[0]?.params.initial_comment).toBe("see files");
    expect(completes[1]?.params.initial_comment).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("uploads attachment without text when text is empty", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const filePath = join(dir, "data.csv");
    await writeFile(filePath, "a,b\n1,2\n");

    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "",
        options: { attach: [filePath] },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls[0]?.method).toBe("files.getUploadURLExternal");
    expect(calls[1]?.method).toBe("files.completeUploadExternal");
    expect(calls[1]?.params.initial_comment).toBeUndefined();
    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(false);
  });

  test("--blocks: reads Block Kit JSON from file and passes through unchanged", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const blocksPath = join(dir, "blocks.json");
    const blocks = [
      { type: "header", text: { type: "plain_text", text: "Digest" } },
      {
        type: "table",
        rows: [
          [
            { type: "raw_text", text: "Name" },
            { type: "raw_text", text: "Why" },
          ],
          [
            { type: "raw_text", text: "Caveman" },
            { type: "raw_text", text: "token cut" },
          ],
        ],
      },
    ];
    await writeFile(blocksPath, JSON.stringify(blocks));

    try {
      await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "fallback text",
        options: { blocks: blocksPath },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.postMessage");
    expect(calls[0]?.params).toEqual({
      channel: "C12345678",
      text: "fallback text",
      thread_ts: undefined,
      blocks,
    });
  });

  test("--blocks: errors when JSON is not an array", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const blocksPath = join(dir, "blocks.json");
    await writeFile(blocksPath, JSON.stringify({ type: "header" }));

    try {
      expect(
        sendMessage({
          ctx,
          targetInput: "C12345678",
          text: "",
          options: { blocks: blocksPath },
        }),
      ).rejects.toThrow(/expected a JSON array/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--blocks: errors on malformed JSON", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const blocksPath = join(dir, "blocks.json");
    await writeFile(blocksPath, "{not valid json");

    try {
      expect(
        sendMessage({
          ctx,
          targetInput: "C12345678",
          text: "",
          options: { blocks: blocksPath },
        }),
      ).rejects.toThrow(/failed to parse JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--blocks: overrides markdown-to-rich-text conversion when text is also provided", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const blocksPath = join(dir, "blocks.json");
    const blocks = [{ type: "divider" }];
    await writeFile(blocksPath, JSON.stringify(blocks));

    try {
      await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "- bullet one\n- bullet two",
        options: { blocks: blocksPath },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls[0]?.params.blocks).toEqual(blocks);
  });

  test("sends Slack manual links in lists as rich-text link blocks", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await sendMessage({
      ctx,
      targetInput: "C12345678",
      text: "- Review <https://example.com/pull/42|PR #42>",
      options: {},
    });

    expect(calls[0]?.method).toBe("chat.postMessage");
    expect(calls[0]?.params.blocks).toEqual([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_list",
            style: "bullet",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "Review " },
                  { type: "link", url: "https://example.com/pull/42", text: "PR #42" },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  test("--blocks: errors when an array element is not an object", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const blocksPath = join(dir, "blocks.json");
    await writeFile(blocksPath, JSON.stringify([{ type: "divider" }, "oops"]));

    try {
      await expect(
        sendMessage({
          ctx,
          targetInput: "C12345678",
          text: "",
          options: { blocks: blocksPath },
        }),
      ).rejects.toThrow(/element at index 1 is not a Block Kit block object/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--schedule sends through chat.scheduleMessage and returns scheduled metadata", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const when = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const postAt = Math.floor(Date.parse(when) / 1000);

    const result = await sendMessage({
      ctx,
      targetInput: "C12345678",
      text: "later",
      options: { schedule: when },
    });

    expect(calls).toEqual([
      {
        method: "chat.scheduleMessage",
        params: {
          channel: "C12345678",
          text: "later",
          post_at: postAt,
          thread_ts: undefined,
        },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      channel_id: "C12345678",
      scheduled_message_id: "Q1234ABCD",
      post_at: postAt,
      thread_ts: undefined,
    });
  });

  test("--schedule-in computes a relative post_at", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const before = Math.floor(Date.now() / 1000);

    await sendMessage({
      ctx,
      targetInput: "C12345678",
      text: "later",
      options: { scheduleIn: "3h" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.scheduleMessage");
    expect(calls[0]?.params.post_at as number).toBeGreaterThanOrEqual(before + 3 * 3600 - 1);
    expect(calls[0]?.params.post_at as number).toBeLessThanOrEqual(before + 3 * 3600 + 1);
  });

  test("records scheduled-message identity after Slack accepts the schedule", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const ctx: CliContext = {
      ...createContext(calls),
      ...receiptLifecycle(receiptEvents),
    };

    const result = await sendMessage({
      ctx,
      targetInput: "C12345678",
      text: "later",
      options: { scheduleIn: "1h" },
    });

    expect(result.receipt_recorded).toBe(true);
    expect(receiptEvents.map((event) => event.phase)).toEqual(["reserve", "finalize"]);
    expect(receiptEvents[0]?.input).toMatchObject({
      workspaceUrl: "https://workspace.slack.com",
      channelId: "C12345678",
      credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
      threadTs: undefined,
      action: "scheduled_send",
      content: "later",
    });
    expect(typeof receiptEvents[0]?.input.postAt).toBe("number");
    expect(receiptEvents[1]?.input).toEqual({
      intentId: "intent-1",
      ts: undefined,
      scheduledMessageId: "Q1234ABCD",
      threadTs: undefined,
    });
  });

  test("--schedule composes with blocks, thread replies, and reply broadcast", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-send-test-"));
    const blocksPath = join(dir, "blocks.json");
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "summary" } }];
    await writeFile(blocksPath, JSON.stringify(blocks));

    try {
      await sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "fallback",
        options: {
          blocks: blocksPath,
          threadTs: "1770160000.000001",
          replyBroadcast: true,
          scheduleIn: "30m",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.scheduleMessage");
    expect(calls[0]?.params).toMatchObject({
      channel: "C12345678",
      text: "fallback",
      thread_ts: "1770160000.000001",
      blocks,
      reply_broadcast: true,
    });
  });

  test("--schedule cannot be combined with file attachments", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await expect(
      sendMessage({
        ctx,
        targetInput: "C12345678",
        text: "later with file",
        options: { attach: ["./report.md"], scheduleIn: "1h" },
      }),
    ).rejects.toThrow(/cannot be combined with --attach/);

    expect(calls).toHaveLength(0);
  });
});

describe("scheduled message management", () => {
  test("matches Slack's numeric list ID to the Q-prefixed mutation ID", async () => {
    const client = {
      api: async () => ({
        ok: true,
        scheduled_messages: [
          {
            id: 1298393284,
            channel_id: "C12345678",
            post_at: 1770168709,
            text: "scheduled",
          },
        ],
        response_metadata: { next_cursor: "" },
      }),
    };

    await expect(
      findScheduledMessageReceiptIdentity(client as never, {
        channelId: "C12345678",
        scheduledMessageId: "Q1298393284",
      }),
    ).resolves.toEqual({ content: "scheduled", postAt: 1770168709, unique: true });
  });

  test("marks a matching scheduled identity ambiguous across Slack items", async () => {
    const client = {
      api: async () => ({
        ok: true,
        scheduled_messages: [
          {
            id: 1298393284,
            channel_id: "C12345678",
            post_at: 1770168709,
            text: "Visit www.example.com :rocket:",
          },
          {
            id: 1298393285,
            channel_id: "C12345678",
            post_at: 1770168709,
            text: "Visit <http://example.com|www.example.com> 🚀",
          },
        ],
        response_metadata: { next_cursor: "" },
      }),
    };

    const identity = await findScheduledMessageReceiptIdentity(client as never, {
      channelId: "C12345678",
      scheduledMessageId: "Q1298393284",
    });
    expect(identity?.unique).toBe(false);
  });

  test("detects a canonical duplicate on a later scheduled-message page", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      api: async (_method: string, params: Record<string, unknown>) => {
        calls.push(params);
        if (!params.cursor) {
          return {
            ok: true,
            scheduled_messages: [
              {
                id: 1298393284,
                channel_id: "C12345678",
                post_at: 1770168709,
                text: "Visit www.example.com :rocket:",
              },
            ],
            response_metadata: { next_cursor: "page-2" },
          };
        }
        return {
          ok: true,
          scheduled_messages: [
            {
              id: 1298393285,
              channel_id: "C12345678",
              post_at: 1770168709,
              text: "Visit <http://example.com|www.example.com> 🚀",
            },
          ],
          response_metadata: { next_cursor: "" },
        };
      },
    };

    const identity = await findScheduledMessageReceiptIdentity(client as never, {
      channelId: "C12345678",
      scheduledMessageId: "Q1298393284",
    });
    expect(identity?.unique).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("fails closed on repeated scheduled-message pagination cursors", async () => {
    const client = {
      api: async () => ({
        ok: true,
        scheduled_messages: [],
        response_metadata: { next_cursor: "repeated" },
      }),
    };

    await expect(
      findScheduledMessageReceiptIdentity(client as never, {
        channelId: "C12345678",
        scheduledMessageId: "Q1298393284",
      }),
    ).rejects.toThrow(/repeated.*cursor/i);
  });

  test("lists scheduled messages and forwards channel filters", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    const result = await listScheduledMessages({
      ctx,
      options: {
        channel: "general",
        cursor: "cursor-1",
        oldest: "1770160000",
        latest: "1770170000",
        limit: "25",
      },
    });

    const listCall = calls.find((c) => c.method === "chat.scheduledMessages.list");
    expect(listCall?.params).toEqual({
      channel: "C12345678",
      cursor: "cursor-1",
      oldest: "1770160000",
      latest: "1770170000",
      limit: 25,
    });
    expect(result).toEqual({
      ok: true,
      scheduled_messages: [
        {
          id: "Q1234ABCD",
          channel_id: "C12345678",
          post_at: 1770168709,
          text: "scheduled",
        },
      ],
      next_cursor: "next-1",
    });
  });

  test("cancels scheduled messages with the required channel id", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    const result = await cancelScheduledMessage({
      ctx,
      scheduledMessageId: "Q1234ABCD",
      options: { channel: "C12345678" },
    });

    expect(calls).toEqual([
      {
        method: "chat.deleteScheduledMessage",
        params: { channel: "C12345678", scheduled_message_id: "Q1234ABCD" },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      channel_id: "C12345678",
      scheduled_message_id: "Q1234ABCD",
    });
  });

  test("normalizes Slack's numeric list ID when cancelling", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await cancelScheduledMessage({
      ctx,
      scheduledMessageId: "1298393284",
      options: { channel: "C12345678" },
    });

    expect(calls).toEqual([
      {
        method: "chat.deleteScheduledMessage",
        params: { channel: "C12345678", scheduled_message_id: "Q1298393284" },
      },
    ]);
  });

  test("removes the exact local receipt after a scheduled cancellation succeeds", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const cleanupInputs: Record<string, unknown>[] = [];
    const ctx: CliContext = {
      ...createContext(calls),
      removeScheduledSendReceipt: async (input) => {
        cleanupInputs.push(input);
        return { finalized_receipt_removed: true, pending_intent_removed: false };
      },
    };

    const result = await cancelScheduledMessage({
      ctx,
      scheduledMessageId: "Q1234ABCD",
      options: { workspace: "https://workspace.slack.com", channel: "C12345678" },
    });

    expect(result).toEqual({
      ok: true,
      channel_id: "C12345678",
      scheduled_message_id: "Q1234ABCD",
      receipt_removed: true,
      pending_intent_removed: false,
    });
    expect(cleanupInputs).toEqual([
      {
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "Q1234ABCD",
        content: "scheduled",
        postAt: 1770168709,
        credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
        reconciledAt: expect.any(Date),
      },
    ]);
  });
});

describe("scheduled message time parsing", () => {
  test("parses absolute ISO timestamps with explicit timezones", () => {
    expect(parseAbsoluteSchedule("2026-06-15T18:00:00-07:00")).toBe(
      Math.floor(Date.parse("2026-06-15T18:00:00-07:00") / 1000),
    );
    expect(() => parseAbsoluteSchedule("2026-06-15T18:00:00")).toThrow(/explicit timezone/);
  });

  test("parses named relative times like monday 9am", () => {
    const now = new Date(2026, 4, 30, 12, 0, 0, 0);
    const result = parseRelativeSchedule("monday 9am", { now });
    const expected = new Date(now);
    expected.setDate(now.getDate() + 2);
    expected.setHours(9, 0, 0, 0);
    expect(result).toBe(Math.floor(expected.getTime() / 1000));
  });

  test("rejects schedule times beyond Slack's 120 day limit", () => {
    const now = new Date(2026, 4, 30, 12, 0, 0, 0);
    const tooFar = new Date(now);
    tooFar.setDate(now.getDate() + 121);
    expect(() => resolveSchedulePostAt({ schedule: tooFar.toISOString() }, { now })).toThrow(
      /120 days/,
    );
  });
});

describe("editMessage", () => {
  test("edits a normal text message without blocks", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await editMessage({
      ctx,
      targetInput: "C12345678",
      text: "hello",
      options: { workspace: "https://workspace.slack.com", ts: "1770165109.628379" },
    });

    expect(calls).toEqual([
      {
        method: "chat.update",
        params: {
          channel: "C12345678",
          ts: "1770165109.628379",
          text: "hello",
        },
      },
    ]);
  });

  test("records an edit only after chat.update succeeds", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const ctx: CliContext = {
      ...createContext(calls),
      ...receiptLifecycle(receiptEvents),
    };

    const result = await editMessage({
      ctx,
      targetInput: "C12345678",
      text: "updated",
      options: { ts: "1770165109.628379" },
    });

    expect(result).toEqual({ ok: true, receipt_recorded: true });
    expect(receiptEvents).toEqual([
      {
        phase: "reserve",
        input: {
          workspaceUrl: "https://workspace.slack.com",
          channelId: "C12345678",
          credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
          ts: "1770165109.628379",
          threadTs: undefined,
          action: "edit",
          content: "updated",
          postAt: undefined,
        },
      },
      {
        phase: "finalize",
        input: {
          intentId: "intent-1",
          ts: "1770165109.628379",
          scheduledMessageId: undefined,
          threadTs: undefined,
        },
      },
    ]);
  });

  test("rejects a malformed known edit ts before chat.update", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx: CliContext = {
      ...createContext(calls),
      ...receiptLifecycle([], { reserveError: new Error("invalid exact Slack timestamp") }),
    };

    await expect(
      editMessage({
        ctx,
        targetInput: "C12345678",
        text: "updated",
        options: { ts: "not-a-slack-ts" },
      }),
    ).rejects.toThrow(/exact Slack timestamp/);
    expect(calls).toEqual([{ method: "auth.test", params: {} }]);
  });

  test("edits literal angle bracket text without blocks", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await editMessage({
      ctx,
      targetInput: "C12345678",
      text: "please use <fix>",
      options: { workspace: "https://workspace.slack.com", ts: "1770165109.628379" },
    });

    expect(calls).toEqual([
      {
        method: "chat.update",
        params: {
          channel: "C12345678",
          ts: "1770165109.628379",
          text: "please use &lt;fix&gt;",
        },
      },
    ]);
  });

  test("edits a message URL with a link label without blocks", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await editMessage({
      ctx,
      targetInput: "https://workspace.slack.com/archives/C12345678/p1770165109628379",
      text: "Visit <https://example.com|Example>",
      options: {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.update");
    expect(calls[0]?.params.channel).toBe("C12345678");
    expect(calls[0]?.params.ts).toBe("1770165109.628379");
    expect(calls[0]?.params.text).toBe("Visit <https://example.com|Example>");
    expect(calls[0]?.params.blocks).toBeUndefined();
  });

  test("edits an inline mailto link without escaping it", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await editMessage({
      ctx,
      targetInput: "C12345678",
      text: "Email <mailto:bob@example.com|Bob>",
      options: { workspace: "https://workspace.slack.com", ts: "1770165109.628379" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.update");
    expect(calls[0]?.params.text).toBe("Email <mailto:bob@example.com|Bob>");
    expect(calls[0]?.params.blocks).toBeUndefined();
  });

  test("edits an inline usergroup mention without escaping it", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await editMessage({
      ctx,
      targetInput: "C12345678",
      text: "Ping <!subteam^S12345678|@team>",
      options: { workspace: "https://workspace.slack.com", ts: "1770165109.628379" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.update");
    expect(calls[0]?.params.text).toBe("Ping <!subteam^S12345678|@team>");
    expect(calls[0]?.params.blocks).toBeUndefined();
  });

  test("edits a channel target with inline formatting without blocks", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await editMessage({
      ctx,
      targetInput: "C12345678",
      text: "Update *now*",
      options: { workspace: "https://workspace.slack.com", ts: "1770165109.628379" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.update");
    expect(calls[0]?.params.text).toBe("Update *now*");
    expect(calls[0]?.params.blocks).toBeUndefined();
  });

  test("edits a channel target with rich text blocks when text contains a list", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    await editMessage({
      ctx,
      targetInput: "C12345678",
      text: "- Post in <#C87654321|general>\n- Update *now*",
      options: { workspace: "https://workspace.slack.com", ts: "1770165109.628379" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.update");
    expect(calls[0]?.params.blocks).toEqual([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_list",
            style: "bullet",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "Post in " },
                  { type: "channel", channel_id: "C87654321" },
                ],
              },
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "Update " },
                  { type: "text", text: "now", style: { bold: true } },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });
});

describe("editMessage", () => {
  test("edits a normal message without blocks when no --blocks file is passed", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);

    const result = await editMessage({
      ctx,
      targetInput: "C12345678",
      text: "hello",
      options: { workspace: "https://workspace.slack.com", ts: "1770165109.628379" },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.update");
    expect(calls[0]?.params).toEqual({
      channel: "C12345678",
      ts: "1770165109.628379",
      text: "hello",
    });
  });

  test("edits a message URL with Block Kit JSON from file", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-edit-test-"));
    const blocksPath = join(dir, "blocks.json");
    const blocks = [
      { type: "header", text: { type: "plain_text", text: "Edited" } },
      { type: "section", text: { type: "mrkdwn", text: "Updated body" } },
    ];
    await writeFile(blocksPath, JSON.stringify(blocks));

    try {
      await editMessage({
        ctx,
        targetInput: "https://workspace.slack.com/archives/C12345678/p1770165109628379",
        text: "fallback text",
        options: { blocks: blocksPath },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.update");
    expect(calls[0]?.params).toEqual({
      channel: "C12345678",
      ts: "1770165109.628379",
      text: "fallback text",
      blocks,
    });
  });

  test("edits a channel target with --ts and Block Kit JSON from file", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ctx = createContext(calls);
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-edit-test-"));
    const blocksPath = join(dir, "blocks.json");
    const blocks = [{ type: "divider" }];
    await writeFile(blocksPath, JSON.stringify(blocks));

    try {
      await editMessage({
        ctx,
        targetInput: "C12345678",
        text: "fallback text",
        options: {
          workspace: "https://workspace.slack.com",
          ts: "1770165109.628379",
          blocks: blocksPath,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("chat.update");
    expect(calls[0]?.params.blocks).toEqual(blocks);
  });
});
