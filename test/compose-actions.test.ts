import { afterEach, describe, expect, mock, test } from "bun:test";
import { composeMessage } from "../src/cli/compose-actions.ts";
import type { CliContext } from "../src/cli/context.ts";

const TEST_CREDENTIAL_FINGERPRINT = "f".repeat(64);

function createComposeContext(input: {
  calls: { method: string; params: Record<string, unknown> }[];
  receiptEvents: { phase: string; input: Record<string, unknown> }[];
}): CliContext {
  return {
    effectiveWorkspaceUrl: (flag?: string) => flag,
    assertWorkspaceSpecifiedForChannelNames: async () => {},
    withAutoRefresh: async <T>(work: {
      workspaceUrl: string | undefined;
      work: () => Promise<T>;
    }) => work.work(),
    getClientForWorkspace: async () => ({
      client: {
        credentialFingerprint: () => TEST_CREDENTIAL_FINGERPRINT,
        api: async (method: string, params: Record<string, unknown>) => {
          input.calls.push({ method, params });
          if (method === "auth.test") {
            return {
              ok: true,
              url: "https://workspace.slack.com/",
              team_id: "T12345678",
              user_id: "U12345678",
            };
          }
          if (method === "chat.postMessage") {
            return { ok: true, channel: params.channel, ts: "1770165109.628379" };
          }
          return { ok: true };
        },
      } as never,
      auth: { auth_type: "standard", token: "x" as const },
      workspace_url: "https://workspace.slack.com",
    }),
    normalizeUrl: (url: string) => url,
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
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
    reserveSendReceipt: mock(async (receiptInput) => {
      input.receiptEvents.push({ phase: "reserve", input: receiptInput });
      return {
        intent_id: "intent-1",
        workspace_url: receiptInput.workspaceUrl,
        channel_id: receiptInput.channelId,
        ts: receiptInput.ts,
        thread_ts: receiptInput.threadTs,
        action: receiptInput.action,
        content_sha256: "a".repeat(64),
        reserved_at: "2026-08-11T18:00:00.000Z",
      };
    }),
    finalizeSendReceipt: mock(async (receiptInput) => {
      input.receiptEvents.push({ phase: "finalize", input: receiptInput });
      return {} as never;
    }),
    cancelSendReceipt: mock(async (receiptInput) => {
      input.receiptEvents.push({ phase: "cancel", input: receiptInput });
    }),
  };
}

describe("composeMessage", () => {
  const originalCi = process.env.CI;

  afterEach(() => {
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
  });

  test("preserves message identifiers and records the successful editor send", async () => {
    process.env.CI = "1";
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const ctx = createComposeContext({ calls, receiptEvents });

    const result = await composeMessage({
      ctx,
      targetInput: "C12345678",
      initialText: "draft text",
      options: { workspace: "https://workspace.slack.com", threadTs: "1770160000.000001" },
    });

    expect(result).toEqual({
      ok: true,
      sent: true,
      editor: "skipped",
      workspace_url: "https://workspace.slack.com",
      channel_id: "C12345678",
      ts: "1770165109.628379",
      thread_ts: "1770160000.000001",
      receipt_recorded: true,
    });
    expect(receiptEvents).toEqual([
      {
        phase: "reserve",
        input: {
          workspaceUrl: "https://workspace.slack.com",
          channelId: "C12345678",
          credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
          threadTs: "1770160000.000001",
          action: "compose_send",
          content: "draft text",
          postAt: undefined,
        },
      },
      {
        phase: "finalize",
        input: {
          intentId: "intent-1",
          ts: "1770165109.628379",
          scheduledMessageId: undefined,
          threadTs: "1770160000.000001",
        },
      },
    ]);
  });

  test("does not record when CI compose is cancelled before sending", async () => {
    process.env.CI = "1";
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const receiptEvents: { phase: string; input: Record<string, unknown> }[] = [];
    const ctx = createComposeContext({ calls, receiptEvents });

    await expect(
      composeMessage({
        ctx,
        targetInput: "C12345678",
        options: { workspace: "https://workspace.slack.com" },
      }),
    ).rejects.toThrow(/initial text is required/);
    expect(calls).toEqual([]);
    expect(receiptEvents).toEqual([]);
  });
});
