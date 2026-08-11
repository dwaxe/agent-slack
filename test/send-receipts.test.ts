import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  finalizeSendReceipt,
  listSendReceipts,
  normalizeReceiptWorkspaceUrl,
  recordSendReceipt,
  removeScheduledSendReceipt,
  reserveSendReceipt,
} from "../src/lib/send-receipts.ts";
import { canonicalSlackTextContentSha256 } from "../src/slack/content-identity.ts";

const CREDENTIAL_A = "a".repeat(64);
const CREDENTIAL_B = "b".repeat(64);

describe("send receipts", () => {
  test("stores only a content hash and lists exact-workspace receipts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    const content = "private message body that must not be stored";
    const recordedAt = new Date("2026-08-11T18:00:00.000Z");

    try {
      const receipt = await recordSendReceipt({
        workspaceUrl: "https://WORKSPACE.slack.com/a/path",
        channelId: "C12345678",
        ts: "1786471200.000001",
        threadTs: "1786471100.000001",
        action: "send",
        content,
        databasePath,
        recordedAt,
      });
      await recordSendReceipt({
        workspaceUrl: "https://other.slack.com",
        channelId: "C87654321",
        ts: "1786471200.000002",
        action: "send",
        content: "other workspace",
        databasePath,
        recordedAt,
      });

      expect(receipt).toEqual({
        channel_id: "C12345678",
        ts: "1786471200.000001",
        thread_ts: "1786471100.000001",
        action: "send",
        content_sha256: createHash("sha256").update(content).digest("hex"),
        canonical_content_sha256: canonicalSlackTextContentSha256(content),
        recorded_at: "2026-08-11T18:00:00.000Z",
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com/",
        databasePath,
      });
      expect(listing.schema_version).toBe(1);
      expect(listing.complete).toBe(true);
      expect(listing.workspace_url).toBe("https://workspace.slack.com");
      expect(listing.tracking_started_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(listing.receipts).toEqual([receipt]);

      const rawDatabase = await readFile(databasePath);
      expect(rawDatabase.includes(Buffer.from(content))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("upserts the same identified mutation safely under concurrency", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    try {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          recordSendReceipt({
            workspaceUrl: "https://workspace.slack.com",
            channelId: "C12345678'; DROP TABLE send_receipts; --",
            ts: "1786471200.000001",
            action: "edit",
            content: "same edit",
            databasePath,
            recordedAt: new Date("2026-08-11T18:00:00.000Z"),
          }),
        ),
      );

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        databasePath,
      });
      expect(listing.receipts).toHaveLength(1);
      expect(listing.receipts[0]?.channel_id).toContain("DROP TABLE");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports coverage completeness and filters on receipt time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    try {
      await recordSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "Q1234ABCD",
        action: "scheduled_send",
        content: "later",
        databasePath,
      });
      const all = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        databasePath,
      });
      const trackingMs = Date.parse(all.tracking_started_at);

      const incomplete = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: String((trackingMs - 1_000) / 1_000),
        databasePath,
      });
      expect(incomplete.complete).toBe(false);
      expect(incomplete.receipts).toHaveLength(1);

      const beforeGraceCoverage = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: String((trackingMs + 120 * 24 * 60 * 60 * 1_000 + 4 * 60 * 1_000) / 1_000),
        latest: String((trackingMs + 121 * 24 * 60 * 60 * 1_000) / 1_000),
        databasePath,
      });
      expect(beforeGraceCoverage.complete).toBe(false);

      const atGraceCoverage = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: String((trackingMs + 120 * 24 * 60 * 60 * 1_000 + 5 * 60 * 1_000) / 1_000),
        latest: String((trackingMs + 121 * 24 * 60 * 60 * 1_000) / 1_000),
        databasePath,
      });
      expect(atGraceCoverage.complete).toBe(true);

      const afterReceipt = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: String((trackingMs + 121 * 24 * 60 * 60 * 1_000) / 1_000),
        latest: String((trackingMs + 122 * 24 * 60 * 60 * 1_000) / 1_000),
        databasePath,
      });
      expect(afterReceipt.complete).toBe(true);
      expect(afterReceipt.receipts).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns scheduled receipts whose delivery is in-window even when recorded earlier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    const postAt = 1_800_000_000;
    try {
      await recordSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "Q1234ABCD",
        action: "scheduled_send",
        content: "scheduled in-window",
        postAt,
        databasePath,
        recordedAt: new Date((postAt - 40 * 24 * 60 * 60) * 1_000),
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: String(postAt - 30 * 24 * 60 * 60),
        latest: String(postAt + 1),
        databasePath,
      });
      expect(listing.receipts).toHaveLength(1);
      expect(listing.receipts[0]).toMatchObject({
        scheduled_message_id: "Q1234ABCD",
        post_at: postAt,
        canonical_content_sha256: canonicalSlackTextContentSha256("scheduled in-window"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("selects finalized receipts by Slack ts when finalization finishes after latest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    try {
      await recordSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        ts: "1786471200.000001",
        action: "edit",
        content: "concurrent edit",
        databasePath,
        recordedAt: new Date("2026-08-11T18:02:00.000Z"),
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: "1786471100.000000",
        latest: "1786471200.999999",
        databasePath,
      });
      expect(listing.receipts).toHaveLength(1);
      expect(listing.receipts[0]?.ts).toBe("1786471200.000001");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("selects unresolved edit intents by target ts when reserved after latest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    try {
      await reserveSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        ts: "1786471200.000001",
        action: "edit",
        content: "unresolved concurrent edit",
        databasePath,
        reservedAt: new Date("2026-08-12T00:00:00.000Z"),
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: "1786471100.000000",
        latest: "1786471200.999999",
        databasePath,
      });
      expect(listing.unresolved_intent_count).toBe(1);
      expect(listing.receipts).toHaveLength(1);
      expect(listing.receipts[0]).toMatchObject({
        ts: "1786471200.000001",
        action: "edit",
        pending: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retains hash-only pending intents reserved after latest to close export races", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    try {
      await reserveSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        action: "send",
        content: "clock-skewed concurrent send",
        databasePath,
        reservedAt: new Date("2026-08-12T00:00:00.000Z"),
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: "1786471100.000000",
        latest: "1786471200.999999",
        databasePath,
      });
      expect(listing.unresolved_intent_count).toBe(1);
      expect(listing.receipts[0]).toMatchObject({ action: "send", pending: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retains a hash-only intent reserved just before the oldest boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    const oldestSeconds = Math.floor(Date.now() / 1_000) - 3_600;
    try {
      await reserveSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        action: "send",
        content: "cross-boundary request",
        databasePath,
        reservedAt: new Date(oldestSeconds * 1_000 - 30_000),
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: `${oldestSeconds}.000000`,
        latest: `${oldestSeconds + 60}.000000`,
        databasePath,
      });
      expect(listing.unresolved_intent_count).toBe(1);
      expect(listing.receipts[0]).toMatchObject({ pending: true, action: "send" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retains a scheduled receipt posted just before the oldest boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    const oldestSeconds = Math.floor(Date.now() / 1_000) - 3_600;
    try {
      await recordSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "QCROSSBOUNDARY",
        action: "scheduled_send",
        content: "scheduled cross-boundary request",
        postAt: oldestSeconds - 30,
        databasePath,
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: `${oldestSeconds}.000000`,
        latest: `${oldestSeconds + 60}.000000`,
        databasePath,
      });
      expect(listing.receipts).toHaveLength(1);
      expect(listing.receipts[0]).toMatchObject({
        action: "scheduled_send",
        scheduled_message_id: "QCROSSBOUNDARY",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed finalized ts and leaves the write-ahead intent pending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    try {
      const intent = await reserveSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        action: "send",
        content: "successful send with malformed response identity",
        databasePath,
      });
      await expect(
        finalizeSendReceipt({
          intentId: intent.intent_id,
          ts: "not-a-slack-ts",
          databasePath,
        }),
      ).rejects.toThrow(/exact Slack timestamp/);

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        databasePath,
      });
      expect(listing.unresolved_intent_count).toBe(1);
      expect(listing.receipts[0]).toMatchObject({ action: "send", pending: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed or out-of-range known ts before persisting an intent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    try {
      for (const ts of ["not-a-slack-ts", "9999999999999.000000"]) {
        await expect(
          reserveSendReceipt({
            workspaceUrl: "https://workspace.slack.com",
            channelId: "C12345678",
            ts,
            action: "edit",
            content: "invalid edit",
            databasePath,
          }),
        ).rejects.toThrow(/Invalid receipt intent ts/);
      }
      await expect(stat(databasePath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lists unresolved intents as hash-only receipts and marks coverage incomplete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    const content = "successful send whose finalization failed";
    try {
      const intent = await reserveSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        action: "send",
        content,
        databasePath,
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        databasePath,
      });
      expect(listing.complete).toBe(false);
      expect(listing.unresolved_intent_count).toBe(1);
      expect(listing.incomplete_reasons).toContain("unresolved_intents");
      expect(listing.receipts).toEqual([
        {
          channel_id: "C12345678",
          action: "send",
          content_sha256: intent.content_sha256,
          canonical_content_sha256: intent.canonical_content_sha256,
          recorded_at: intent.reserved_at,
          pending: true,
        },
      ]);
      expect((await readFile(databasePath)).includes(Buffer.from(content))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("matches a ts-less outbound URL with prose punctuation to Slack's autolink form", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    try {
      await reserveSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        action: "send",
        content: "See https://example.com.",
        databasePath,
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        databasePath,
      });
      expect(listing.receipts[0]?.ts).toBeUndefined();
      expect(listing.receipts[0]?.canonical_content_sha256).toBe(
        canonicalSlackTextContentSha256("See <https://example.com>."),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reconciles a pending scheduled intent after finalization failure and cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    const postAt = 1_800_000_000;
    const reservedAt = new Date("2026-08-11T18:00:00.000Z");
    const reconciledAt = new Date("2026-08-11T18:06:00.000Z");
    try {
      await reserveSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        action: "scheduled_send",
        content: "Deploy via www.example.com :rocket: &amp; notify alice@example.com",
        credentialFingerprint: CREDENTIAL_A,
        postAt,
        reservedAt,
        databasePath,
      });

      const cleanup = await removeScheduledSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "Q1234ABCD",
        content:
          "Deploy via <http://example.com|www.example.com> 🚀 & notify <mailto:alice@example.com|alice@example.com>",
        credentialFingerprint: CREDENTIAL_A,
        postAt,
        reconciledAt,
        databasePath,
      });
      expect(cleanup).toEqual({
        finalized_receipt_removed: false,
        pending_intent_removed: true,
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: String(postAt - 1),
        latest: String(postAt + 1),
        databasePath,
      });
      expect(listing.unresolved_intent_count).toBe(0);
      expect(listing.receipts).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reconciles pending schedules only for the exact Slack credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    const postAt = 1_800_000_000;
    const reservedAt = new Date("2026-08-11T18:00:00.000Z");
    const reconciledAt = new Date("2026-08-11T18:06:00.000Z");
    try {
      await reserveSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        credentialFingerprint: CREDENTIAL_A,
        action: "scheduled_send",
        content: "same schedule after token rotation",
        postAt,
        reservedAt,
        databasePath,
      });

      const differentCredentialCleanup = await removeScheduledSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "QUNKNOWN",
        content: "same schedule after token rotation",
        postAt,
        credentialFingerprint: CREDENTIAL_B,
        reconciledAt,
        databasePath,
      });
      expect(differentCredentialCleanup.pending_intent_removed).toBe(false);

      const sameCredentialCleanup = await removeScheduledSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "QUNKNOWN",
        content: "same schedule after token rotation",
        postAt,
        credentialFingerprint: CREDENTIAL_A,
        reconciledAt,
        databasePath,
      });
      expect(sameCredentialCleanup.pending_intent_removed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retains a fresh matching schedule intent during cancellation reconciliation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    const reservedAt = new Date("2026-08-11T18:00:00.000Z");
    const postAt = 1_800_000_000;
    try {
      await reserveSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        credentialFingerprint: CREDENTIAL_A,
        action: "scheduled_send",
        content: "in-flight identical schedule",
        postAt,
        reservedAt,
        databasePath,
      });

      const cleanup = await removeScheduledSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "QEXISTING",
        content: "in-flight identical schedule",
        credentialFingerprint: CREDENTIAL_A,
        postAt,
        reconciledAt: new Date("2026-08-11T18:04:59.999Z"),
        databasePath,
      });
      expect(cleanup.pending_intent_removed).toBe(false);

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: String(postAt - 1),
        latest: String(postAt + 1),
        databasePath,
      });
      expect(listing.unresolved_intent_count).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exact finalized scheduled ID wins over a matching pending retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    const postAt = 1_800_000_000;
    const content = "identical retry";
    try {
      await reserveSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        action: "scheduled_send",
        content,
        credentialFingerprint: CREDENTIAL_A,
        postAt,
        databasePath,
      });
      await recordSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "QFINALIZED",
        action: "scheduled_send",
        content,
        postAt,
        databasePath,
      });

      const cleanup = await removeScheduledSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "QFINALIZED",
        content,
        postAt,
        credentialFingerprint: CREDENTIAL_A,
        databasePath,
      });
      expect(cleanup).toEqual({
        finalized_receipt_removed: true,
        pending_intent_removed: false,
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: String(postAt - 1),
        latest: String(postAt + 1),
        databasePath,
      });
      expect(listing.unresolved_intent_count).toBe(1);
      expect(listing.receipts).toHaveLength(1);
      expect(listing.receipts[0]).toMatchObject({ pending: true, action: "scheduled_send" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retains locally ambiguous pending schedules during heuristic cancellation cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    const postAt = 1_800_000_000;
    const reservedAt = new Date("2026-08-11T18:00:00.000Z");
    const reconciledAt = new Date("2026-08-11T18:06:00.000Z");
    try {
      for (let index = 0; index < 2; index++) {
        await reserveSendReceipt({
          workspaceUrl: "https://workspace.slack.com",
          channelId: "C12345678",
          action: "scheduled_send",
          content: "same pending schedule",
          credentialFingerprint: CREDENTIAL_A,
          postAt,
          reservedAt,
          databasePath,
        });
      }

      await expect(
        removeScheduledSendReceipt({
          workspaceUrl: "https://workspace.slack.com",
          channelId: "C12345678",
          scheduledMessageId: "QUNKNOWN",
          content: "same pending schedule",
          credentialFingerprint: CREDENTIAL_A,
          postAt,
          reconciledAt,
          databasePath,
        }),
      ).rejects.toThrow(/ambiguous/);
      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: String(postAt - 1),
        latest: String(postAt + 1),
        databasePath,
      });
      expect(listing.unresolved_intent_count).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a reversed window within the same millisecond", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    try {
      await expect(
        listSendReceipts({
          workspaceUrl: "https://workspace.slack.com",
          oldest: "1786471200.000999",
          latest: "1786471200.000001",
          databasePath,
        }),
      ).rejects.toThrow("Oldest receipt timestamp must not be after latest");
      await expect(stat(databasePath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("migrates legacy exact-ts receipts without requiring a fallback hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const stateDir = join(dir, "state");
    const databasePath = join(stateDir, "send-receipts.sqlite3");
    await mkdir(stateDir, { mode: 0o700 });
    const legacy = new Database(databasePath, { create: true });
    try {
      legacy.exec(`CREATE TABLE send_receipt_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE send_receipts (
        receipt_key TEXT PRIMARY KEY NOT NULL,
        workspace_url TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        ts TEXT,
        scheduled_message_id TEXT,
        thread_ts TEXT,
        action TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        post_at INTEGER,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE send_receipt_intents (
        intent_id TEXT PRIMARY KEY NOT NULL,
        workspace_url TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        ts TEXT,
        thread_ts TEXT,
        action TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        post_at INTEGER,
        reserved_at TEXT NOT NULL
      );`);
      legacy
        .query("INSERT INTO send_receipt_metadata (key, value) VALUES (?, ?)")
        .run("tracking_started_at", "2020-01-01T00:00:00.000Z");
      legacy
        .query(
          `INSERT INTO send_receipts (
             receipt_key, workspace_url, channel_id, ts, scheduled_message_id,
             thread_ts, action, content_sha256, post_at, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "legacy-key",
          "https://workspace.slack.com",
          "C12345678",
          "1786471200.000001",
          null,
          null,
          "send",
          "a".repeat(64),
          null,
          "2026-08-11T18:00:00.000Z",
        );
    } finally {
      legacy.close();
    }

    try {
      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: "1786471200.000000",
        latest: "1786471200.999999",
        databasePath,
      });
      expect(listing.complete).toBe(true);
      expect(listing.incomplete_reasons).not.toContain("missing_canonical_content_hashes");
      expect(listing.receipts).toEqual([
        {
          channel_id: "C12345678",
          ts: "1786471200.000001",
          action: "send",
          content_sha256: "a".repeat(64),
          recorded_at: "2026-08-11T18:00:00.000Z",
        },
      ]);

      const migrated = new Database(databasePath);
      try {
        migrated
          .query(
            `INSERT INTO send_receipts (
               receipt_key, workspace_url, channel_id, ts, scheduled_message_id,
               thread_ts, action, content_sha256, post_at, recorded_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "legacy-scheduled-key",
            "https://workspace.slack.com",
            "C12345678",
            null,
            "QLEGACY",
            null,
            "scheduled_send",
            "b".repeat(64),
            1_786_471_200,
            "2026-08-11T18:00:00.000Z",
          );
      } finally {
        migrated.close();
      }
      const fallbackListing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: "1786471200.000000",
        latest: "1786471200.999999",
        databasePath,
      });
      expect(fallbackListing.complete).toBe(false);
      expect(fallbackListing.incomplete_reasons).toContain("missing_canonical_content_hashes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bounds future schedules and aged immediate intents to the requested window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    const nowSeconds = Math.floor(Date.now() / 1_000);
    try {
      await recordSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "QFUTURE",
        action: "scheduled_send",
        content: "future",
        postAt: nowSeconds + 3_600,
        databasePath,
      });
      await reserveSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        action: "send",
        content: "old unresolved",
        reservedAt: new Date((nowSeconds - 60 * 24 * 60 * 60) * 1_000),
        databasePath,
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        oldest: String(nowSeconds - 30 * 24 * 60 * 60),
        latest: String(nowSeconds),
        databasePath,
      });
      expect(listing.receipts).toEqual([]);
      expect(listing.unresolved_intent_count).toBe(0);
      expect(listing.incomplete_reasons).not.toContain("unresolved_intents");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removes only the exact canceled scheduled receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    try {
      for (const scheduledMessageId of ["QREMOVE", "QKEEP"]) {
        await recordSendReceipt({
          workspaceUrl: "https://workspace.slack.com",
          channelId: "C12345678",
          scheduledMessageId,
          action: "scheduled_send",
          content: scheduledMessageId,
          postAt: Math.floor(Date.now() / 1_000),
          databasePath,
        });
      }
      await removeScheduledSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "QREMOVE",
        databasePath,
      });

      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        databasePath,
      });
      expect(listing.receipts).toHaveLength(1);
      expect(listing.receipts[0]?.scheduled_message_id).toBe("QKEEP");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removes a Q-prefixed finalized receipt through Slack's numeric list ID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const databasePath = join(dir, "state", "send-receipts.sqlite3");
    try {
      const receipt = await recordSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "Q1298393284",
        action: "scheduled_send",
        content: "documented Slack shape",
        postAt: 1_800_000_000,
        databasePath,
      });
      expect(receipt.scheduled_message_id).toBe("1298393284");

      const cleanup = await removeScheduledSendReceipt({
        workspaceUrl: "https://workspace.slack.com",
        channelId: "C12345678",
        scheduledMessageId: "1298393284",
        databasePath,
      });
      expect(cleanup).toEqual({
        finalized_receipt_removed: true,
        pending_intent_removed: false,
      });
      const listing = await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        databasePath,
      });
      expect(listing.receipts).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates owner-only state directories and SQLite files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const stateDir = join(dir, "state");
    const databasePath = join(stateDir, "send-receipts.sqlite3");
    try {
      await listSendReceipts({
        workspaceUrl: "https://workspace.slack.com",
        databasePath,
      });

      expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
      for (const suffix of ["-wal", "-shm"]) {
        try {
          expect((await stat(`${databasePath}${suffix}`)).mode & 0o777).toBe(0o600);
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects symlinked and non-directory state paths before opening SQLite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const victimDir = join(dir, "victim");
    const linkedStateDir = join(dir, "linked-state");
    const fileStateDir = join(dir, "file-state");
    await mkdir(victimDir);
    await symlink(victimDir, linkedStateDir);
    await writeFile(fileStateDir, "not a directory");
    try {
      await expect(
        listSendReceipts({
          workspaceUrl: "https://workspace.slack.com",
          databasePath: join(linkedStateDir, "send-receipts.sqlite3"),
        }),
      ).rejects.toThrow(/unsafe agent-slack state directory/);
      await expect(
        listSendReceipts({
          workspaceUrl: "https://workspace.slack.com",
          databasePath: join(fileStateDir, "send-receipts.sqlite3"),
        }),
      ).rejects.toThrow();
      await expect(stat(join(victimDir, "send-receipts.sqlite3"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects symlinked and non-regular database targets without changing the victim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-receipts-test-"));
    const stateDir = join(dir, "state");
    const victim = join(dir, "victim.txt");
    const linkedDatabase = join(stateDir, "linked.sqlite3");
    const directoryDatabase = join(stateDir, "directory.sqlite3");
    await mkdir(stateDir);
    await writeFile(victim, "unchanged");
    await symlink(victim, linkedDatabase);
    await mkdir(directoryDatabase);
    try {
      await expect(
        listSendReceipts({
          workspaceUrl: "https://workspace.slack.com",
          databasePath: linkedDatabase,
        }),
      ).rejects.toThrow(/unsafe send receipt database/);
      await expect(
        listSendReceipts({
          workspaceUrl: "https://workspace.slack.com",
          databasePath: directoryDatabase,
        }),
      ).rejects.toThrow(/unsafe send receipt database/);
      expect(await readFile(victim, "utf8")).toBe("unchanged");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("accepts only HTTPS Slack workspace origins", () => {
    expect(normalizeReceiptWorkspaceUrl("https://Example.Slack.com/path?q=1")).toBe(
      "https://example.slack.com",
    );
    expect(() => normalizeReceiptWorkspaceUrl("http://example.slack.com")).toThrow(/HTTPS/);
    expect(() => normalizeReceiptWorkspaceUrl("https://example.com")).toThrow(
      /Not a Slack workspace URL/,
    );
    expect(() => normalizeReceiptWorkspaceUrl("https://user@example.slack.com")).toThrow(
      /credentials/,
    );
    expect(normalizeReceiptWorkspaceUrl("https://example.slack-gov.com")).toBe(
      "https://example.slack-gov.com",
    );
  });
});
