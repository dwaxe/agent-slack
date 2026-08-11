import { createHash, randomUUID } from "node:crypto";
import { inImmediateTransaction, openSendReceiptDatabase } from "./send-receipts-sqlite.ts";
import {
  canonicalSlackTextContentSha256,
  slackTextContentSha256,
} from "../slack/content-identity.ts";
import { normalizeSlackScheduledMessageId } from "../slack/scheduled-message-id.ts";

export { getSendReceiptsDatabasePath } from "./send-receipts-sqlite.ts";

export const SEND_RECEIPTS_SCHEMA_VERSION = 1 as const;

export type ReceiptAction = "send" | "compose_send" | "attachment_send" | "scheduled_send" | "edit";

export type SendReceipt = {
  channel_id: string;
  ts?: string;
  scheduled_message_id?: string;
  thread_ts?: string;
  action: ReceiptAction;
  content_sha256: string;
  canonical_content_sha256?: string;
  post_at?: number;
  recorded_at: string;
  pending?: boolean;
};

export type SendReceiptIntent = {
  intent_id: string;
  workspace_url: string;
  channel_id: string;
  ts?: string;
  thread_ts?: string;
  action: ReceiptAction;
  content_sha256: string;
  canonical_content_sha256?: string;
  post_at?: number;
  reserved_at: string;
};

export type ReserveSendReceiptInput = {
  workspaceUrl: string;
  channelId: string;
  /** One-way identity of the exact Slack credential; stored locally and never listed. */
  credentialFingerprint?: string;
  ts?: string;
  threadTs?: string;
  action: ReceiptAction;
  content: string;
  postAt?: number;
  databasePath?: string;
  reservedAt?: Date;
};

export type FinalizeSendReceiptInput = {
  intentId: string;
  ts?: string;
  scheduledMessageId?: string;
  threadTs?: string;
  databasePath?: string;
  recordedAt?: Date;
};

export type CancelSendReceiptInput = {
  intentId: string;
  databasePath?: string;
};

export type RemoveScheduledSendReceiptInput = {
  workspaceUrl: string;
  channelId: string;
  scheduledMessageId: string;
  /** Slack's pre-cancellation scheduled-message text, used to reconcile an unresolved intent. */
  content?: string;
  postAt?: number;
  /** One-way identity of the exact Slack credential, required for intent reconciliation. */
  credentialFingerprint?: string;
  databasePath?: string;
  /** Testable clock for the stale-intent reconciliation guard. */
  reconciledAt?: Date;
};

export type RemoveScheduledSendReceiptResult = {
  finalized_receipt_removed: boolean;
  pending_intent_removed: boolean;
};

export type RecordSendReceiptInput = {
  workspaceUrl: string;
  channelId: string;
  ts?: string;
  scheduledMessageId?: string;
  threadTs?: string;
  action: ReceiptAction;
  content: string;
  postAt?: number;
  databasePath?: string;
  recordedAt?: Date;
};

export type ListSendReceiptsInput = {
  workspaceUrl: string;
  /** Inclusive Slack/Unix lower bound on message ts, scheduled post_at, or local fallback time. */
  oldest?: string;
  /** Inclusive Slack/Unix upper bound. Defaults to the current instant. */
  latest?: string;
  databasePath?: string;
};

export type SendReceiptListing = {
  schema_version: typeof SEND_RECEIPTS_SCHEMA_VERSION;
  complete: boolean;
  workspace_url: string;
  /** UTC ISO-8601 timestamp for when local mutation tracking began. */
  tracking_started_at: string;
  unresolved_intent_count: number;
  incomplete_reasons: string[];
  receipts: SendReceipt[];
};

const RECEIPT_ACTIONS = new Set<ReceiptAction>([
  "send",
  "compose_send",
  "attachment_send",
  "scheduled_send",
  "edit",
]);

const TRACKING_STARTED_AT_KEY = "tracking_started_at";
const FALLBACK_OLDEST_GRACE_MS = 5 * 60 * 1_000;
const SCHEDULE_RECONCILIATION_MIN_AGE_MS = 5 * 60 * 1_000;

export function normalizeReceiptWorkspaceUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Receipt workspace URL is required");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid receipt workspace URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Receipt workspace URL must use HTTPS: ${raw}`);
  }
  if (!/\.(?:slack\.com|slack-gov\.com)$/i.test(url.hostname)) {
    throw new Error(`Not a Slack workspace URL: ${url.hostname}`);
  }
  if (url.username || url.password || url.port) {
    throw new Error("Receipt workspace URL must not include credentials or a custom port");
  }
  return `https://${url.hostname.toLowerCase()}`;
}

export async function recordSendReceipt(input: RecordSendReceiptInput): Promise<SendReceipt> {
  const intent = await reserveSendReceipt({
    workspaceUrl: input.workspaceUrl,
    channelId: input.channelId,
    ts: input.ts,
    threadTs: input.threadTs,
    action: input.action,
    content: input.content,
    postAt: input.postAt,
    databasePath: input.databasePath,
    reservedAt: input.recordedAt,
  });
  return finalizeSendReceipt({
    intentId: intent.intent_id,
    ts: input.ts,
    scheduledMessageId: input.scheduledMessageId,
    threadTs: input.threadTs,
    databasePath: input.databasePath,
    recordedAt: input.recordedAt,
  });
}

export async function reserveSendReceipt(
  input: ReserveSendReceiptInput,
): Promise<SendReceiptIntent> {
  const workspaceUrl = normalizeReceiptWorkspaceUrl(input.workspaceUrl);
  const channelId = requireNonEmpty(input.channelId, "channel ID");
  const action = requireReceiptAction(input.action);
  const reservedAt = requireValidDate(input.reservedAt ?? new Date(), "reservedAt").toISOString();
  const contentSha256 = slackTextContentSha256(input.content);
  const canonicalContentSha256 = canonicalSlackTextContentSha256(input.content);
  const credentialFingerprint = optionalSha256(
    input.credentialFingerprint,
    "credential fingerprint",
  );
  const ts = optionalExactSlackTimestamp(input.ts, "intent ts");
  const threadTs = optionalExactSlackTimestamp(input.threadTs, "intent thread_ts");
  const postAt = optionalPostAt(input.postAt);
  const intentId = randomUUID();
  const db = await openSendReceiptDatabase(input.databasePath);
  let reserved = false;
  try {
    inImmediateTransaction(db, () => {
      db.prepare(
        `INSERT INTO send_receipt_intents (
           intent_id, workspace_url, channel_id, ts, thread_ts, action,
           content_sha256, canonical_content_sha256, credential_fingerprint, post_at, reserved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        intentId,
        workspaceUrl,
        channelId,
        ts ?? null,
        threadTs ?? null,
        action,
        contentSha256,
        canonicalContentSha256,
        credentialFingerprint ?? null,
        postAt ?? null,
        reservedAt,
      );
    });
    reserved = true;
  } finally {
    closeAfterTransaction(db, reserved);
  }

  return compactIntent({
    intent_id: intentId,
    workspace_url: workspaceUrl,
    channel_id: channelId,
    ts,
    thread_ts: threadTs,
    action,
    content_sha256: contentSha256,
    canonical_content_sha256: canonicalContentSha256,
    post_at: postAt,
    reserved_at: reservedAt,
  });
}

export async function finalizeSendReceipt(input: FinalizeSendReceiptInput): Promise<SendReceipt> {
  const intentId = requireNonEmpty(input.intentId, "intent ID");
  const recordedAt = requireValidDate(input.recordedAt ?? new Date(), "recordedAt").toISOString();
  const ts = optionalExactSlackTimestamp(input.ts, "finalized ts");
  const rawScheduledMessageId = optionalNonEmpty(input.scheduledMessageId);
  const scheduledMessageId = rawScheduledMessageId
    ? normalizeSlackScheduledMessageId(rawScheduledMessageId)
    : undefined;
  const finalizedThreadTs = optionalExactSlackTimestamp(input.threadTs, "finalized thread_ts");
  const db = await openSendReceiptDatabase(input.databasePath);
  let receipt: SendReceipt | undefined;
  try {
    inImmediateTransaction(db, () => {
      const row = db
        .prepare(
          `SELECT workspace_url, channel_id, ts, thread_ts, action, content_sha256,
                  canonical_content_sha256, post_at, reserved_at
             FROM send_receipt_intents
            WHERE intent_id = ?`,
        )
        .get(intentId);
      if (!row) {
        throw new Error(`Send receipt intent not found: ${intentId}`);
      }
      const intent = rowToIntent({ ...row, intent_id: intentId });
      const finalTs = ts ?? intent.ts;
      const threadTs = finalizedThreadTs ?? intent.thread_ts;
      const receiptKey = sha256(
        JSON.stringify([
          intent.workspace_url,
          intent.channel_id,
          finalTs ?? null,
          scheduledMessageId ?? null,
          threadTs ?? null,
          intent.action,
          intent.content_sha256,
          finalTs || scheduledMessageId ? null : intentId,
        ]),
      );
      db.prepare(
        `INSERT INTO send_receipts (
           receipt_key,
           workspace_url,
           channel_id,
           ts,
           scheduled_message_id,
           thread_ts,
           action,
           content_sha256,
           canonical_content_sha256,
           post_at,
           recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(receipt_key) DO UPDATE SET
           ts = COALESCE(send_receipts.ts, excluded.ts),
           scheduled_message_id = COALESCE(
             send_receipts.scheduled_message_id,
             excluded.scheduled_message_id
           ),
           thread_ts = COALESCE(send_receipts.thread_ts, excluded.thread_ts),
           canonical_content_sha256 = COALESCE(
             send_receipts.canonical_content_sha256,
             excluded.canonical_content_sha256
           ),
           post_at = COALESCE(send_receipts.post_at, excluded.post_at),
           recorded_at = CASE
             WHEN excluded.recorded_at < send_receipts.recorded_at THEN excluded.recorded_at
             ELSE send_receipts.recorded_at
           END`,
      ).run(
        receiptKey,
        intent.workspace_url,
        intent.channel_id,
        finalTs ?? null,
        scheduledMessageId ?? null,
        threadTs ?? null,
        intent.action,
        intent.content_sha256,
        intent.canonical_content_sha256 ?? null,
        intent.post_at ?? null,
        recordedAt,
      );
      db.prepare("DELETE FROM send_receipt_intents WHERE intent_id = ?").run(intentId);
      receipt = compactReceipt({
        channel_id: intent.channel_id,
        ts: finalTs,
        scheduled_message_id: scheduledMessageId,
        thread_ts: threadTs,
        action: intent.action,
        content_sha256: intent.content_sha256,
        canonical_content_sha256: intent.canonical_content_sha256,
        post_at: intent.post_at,
        recorded_at: recordedAt,
      });
    });
  } finally {
    closeAfterTransaction(db, receipt !== undefined);
  }

  if (!receipt) {
    throw new Error(`Failed to finalize send receipt intent: ${intentId}`);
  }
  return receipt;
}

export async function cancelSendReceipt(input: CancelSendReceiptInput): Promise<void> {
  const intentId = requireNonEmpty(input.intentId, "intent ID");
  const db = await openSendReceiptDatabase(input.databasePath);
  let cancelled = false;
  try {
    inImmediateTransaction(db, () => {
      db.prepare("DELETE FROM send_receipt_intents WHERE intent_id = ?").run(intentId);
    });
    cancelled = true;
  } finally {
    closeAfterTransaction(db, cancelled);
  }
}

export async function removeScheduledSendReceipt(
  input: RemoveScheduledSendReceiptInput,
): Promise<RemoveScheduledSendReceiptResult> {
  const workspaceUrl = normalizeReceiptWorkspaceUrl(input.workspaceUrl);
  const channelId = requireNonEmpty(input.channelId, "channel ID");
  const rawScheduledMessageId = requireNonEmpty(input.scheduledMessageId, "scheduled message ID");
  const scheduledMessageId = normalizeSlackScheduledMessageId(rawScheduledMessageId);
  const prefixedScheduledMessageId = /^\d+$/.test(scheduledMessageId)
    ? `Q${scheduledMessageId}`
    : scheduledMessageId;
  const postAt = optionalPostAt(input.postAt);
  const canonicalContentSha256 =
    input.content === undefined ? undefined : canonicalSlackTextContentSha256(input.content);
  const credentialFingerprint = optionalSha256(
    input.credentialFingerprint,
    "credential fingerprint",
  );
  const descriptorParts = [postAt, canonicalContentSha256, credentialFingerprint];
  if (
    descriptorParts.some((value) => value !== undefined) &&
    !descriptorParts.every((value) => value !== undefined)
  ) {
    throw new Error(
      "Scheduled receipt cleanup requires content, postAt, and credentialFingerprint together",
    );
  }
  const reconciledAt = requireValidDate(input.reconciledAt ?? new Date(), "reconciledAt");
  const staleIntentCutoff = new Date(
    reconciledAt.getTime() - SCHEDULE_RECONCILIATION_MIN_AGE_MS,
  ).toISOString();
  const db = await openSendReceiptDatabase(input.databasePath);
  let result: RemoveScheduledSendReceiptResult | undefined;
  try {
    inImmediateTransaction(db, () => {
      const finalized = db
        .prepare(
          `SELECT receipt_key
             FROM send_receipts
            WHERE workspace_url = ?
              AND channel_id = ?
              AND scheduled_message_id IN (?, ?, ?)`,
        )
        .all(
          workspaceUrl,
          channelId,
          rawScheduledMessageId,
          scheduledMessageId,
          prefixedScheduledMessageId,
        );
      let pendingIntentId: string | undefined;
      // An exact finalized scheduled ID is authoritative. A hash/time match is
      // only safe when no exact receipt exists; otherwise it may be a separate
      // retry whose Slack response was lost and which can still deliver later.
      if (
        finalized.length === 0 &&
        postAt !== undefined &&
        canonicalContentSha256 !== undefined &&
        credentialFingerprint !== undefined
      ) {
        const pending = db
          .prepare(
            `SELECT intent_id
               FROM send_receipt_intents
              WHERE workspace_url = ?
                AND channel_id = ?
                AND action = 'scheduled_send'
                AND post_at = ?
                AND canonical_content_sha256 = ?
                AND credential_fingerprint = ?
                AND reserved_at <= ?
              ORDER BY reserved_at ASC, intent_id ASC`,
          )
          .all(
            workspaceUrl,
            channelId,
            postAt,
            canonicalContentSha256,
            credentialFingerprint,
            staleIntentCutoff,
          );
        if (pending.length > 1) {
          throw new Error(
            "Scheduled receipt cleanup is ambiguous; retaining unresolved provenance intents",
          );
        }
        if (pending.length === 1) {
          pendingIntentId = requireStoredString(pending[0]?.intent_id, "intent_id");
        }

        const legacyPending = db
          .prepare(
            `SELECT intent_id
               FROM send_receipt_intents
              WHERE workspace_url = ?
                AND channel_id = ?
                AND action = 'scheduled_send'
                AND post_at = ?
                AND (
                  canonical_content_sha256 IS NULL
                  OR credential_fingerprint IS NULL
                )
              LIMIT 1`,
          )
          .get(workspaceUrl, channelId, postAt);
        if (legacyPending) {
          throw new Error(
            "Scheduled receipt cleanup found legacy unresolved provenance without canonical content or credential identity",
          );
        }
      }

      db.prepare(
        `DELETE FROM send_receipts
          WHERE workspace_url = ?
            AND channel_id = ?
            AND scheduled_message_id IN (?, ?, ?)`,
      ).run(
        workspaceUrl,
        channelId,
        rawScheduledMessageId,
        scheduledMessageId,
        prefixedScheduledMessageId,
      );
      if (pendingIntentId) {
        db.prepare("DELETE FROM send_receipt_intents WHERE intent_id = ?").run(pendingIntentId);
      }
      result = {
        finalized_receipt_removed: finalized.length > 0,
        pending_intent_removed: pendingIntentId !== undefined,
      };
    });
  } finally {
    closeAfterTransaction(db, result !== undefined);
  }
  if (!result) {
    throw new Error("Failed to clean up scheduled send receipt");
  }
  return result;
}

export async function listSendReceipts(input: ListSendReceiptsInput): Promise<SendReceiptListing> {
  const workspaceUrl = normalizeReceiptWorkspaceUrl(input.workspaceUrl);
  const oldest = parseReceiptBound(input.oldest, "oldest");
  const latest =
    parseReceiptBound(input.latest, "latest") ?? receiptBoundFromMilliseconds(Date.now());
  if (oldest && BigInt(oldest.slackMicroseconds) > BigInt(latest.slackMicroseconds)) {
    throw new Error("Oldest receipt timestamp must not be after latest");
  }
  const oldestIso = oldest?.iso ?? "0000-01-01T00:00:00.000Z";
  const fallbackOldestMilliseconds = oldest
    ? Math.max(0, oldest.epochMilliseconds - FALLBACK_OLDEST_GRACE_MS)
    : 0;
  const fallbackOldestIso = oldest ? new Date(fallbackOldestMilliseconds).toISOString() : oldestIso;
  const fallbackOldestSeconds = oldest ? Math.floor(fallbackOldestMilliseconds / 1_000) : 0;
  const latestSeconds = Math.floor(latest.epochMilliseconds / 1_000);
  const db = await openSendReceiptDatabase(input.databasePath);
  try {
    const metadata = db
      .prepare("SELECT value FROM send_receipt_metadata WHERE key = ?")
      .get(TRACKING_STARTED_AT_KEY);
    const trackingStartedAt = requireStoredString(metadata?.value, TRACKING_STARTED_AT_KEY);
    const rows = db
      .prepare(
        `SELECT workspace_url, channel_id, ts, scheduled_message_id, thread_ts,
                action, content_sha256, canonical_content_sha256, post_at, recorded_at
           FROM send_receipts
          WHERE workspace_url = ?
            AND (
              (
                ts IS NOT NULL
                AND (
                  CAST(substr(ts, 1, instr(ts, '.') - 1) AS INTEGER) * 1000000
                  + CAST(
                    substr(substr(ts, instr(ts, '.') + 1) || '000000', 1, 6)
                    AS INTEGER
                  )
                ) BETWEEN CAST(? AS INTEGER) AND CAST(? AS INTEGER)
              )
              OR (
                ts IS NULL AND post_at IS NOT NULL
                AND post_at >= ? AND post_at <= ?
              )
              OR (
                ts IS NULL AND post_at IS NULL
                AND recorded_at >= ?
              )
            )
          ORDER BY recorded_at ASC, receipt_key ASC`,
      )
      .all(
        workspaceUrl,
        oldest?.slackMicroseconds ?? "0",
        latest.slackMicroseconds,
        fallbackOldestSeconds,
        latestSeconds,
        fallbackOldestIso,
      );
    const pendingRows = db
      .prepare(
        `SELECT intent_id, workspace_url, channel_id, ts, thread_ts, action,
                content_sha256, canonical_content_sha256, post_at, reserved_at
           FROM send_receipt_intents
          WHERE workspace_url = ?
            AND (
              (
                ts IS NOT NULL
                AND (
                  CAST(substr(ts, 1, instr(ts, '.') - 1) AS INTEGER) * 1000000
                  + CAST(
                    substr(substr(ts, instr(ts, '.') + 1) || '000000', 1, 6)
                    AS INTEGER
                  )
                ) BETWEEN CAST(? AS INTEGER) AND CAST(? AS INTEGER)
              )
              OR (
                ts IS NULL AND post_at IS NOT NULL
                AND post_at >= ? AND post_at <= ?
              )
              OR (
                ts IS NULL AND post_at IS NULL
                AND reserved_at >= ?
              )
            )
          ORDER BY reserved_at ASC, intent_id ASC`,
      )
      .all(
        workspaceUrl,
        oldest?.slackMicroseconds ?? "0",
        latest.slackMicroseconds,
        fallbackOldestSeconds,
        latestSeconds,
        fallbackOldestIso,
      );
    const receipts = [...rows.map(rowToReceipt), ...pendingRows.map(rowToPendingReceipt)].sort(
      (left, right) => left.recorded_at.localeCompare(right.recorded_at),
    );
    const scheduleHorizonMs = 120 * 24 * 60 * 60 * 1000;
    const trackingCoversWindow = oldest
      ? Date.parse(trackingStartedAt) + scheduleHorizonMs <= fallbackOldestMilliseconds
      : true;
    const incompleteReasons: string[] = [];
    if (!trackingCoversWindow) {
      incompleteReasons.push("tracking_started_too_recent_for_scheduled_horizon");
    }
    if (pendingRows.length > 0) {
      incompleteReasons.push("unresolved_intents");
    }
    const missingCanonicalHash = [...rows, ...pendingRows].some(
      (row) => row.ts === null && row.canonical_content_sha256 === null,
    );
    if (missingCanonicalHash) {
      incompleteReasons.push("missing_canonical_content_hashes");
    }

    return {
      schema_version: SEND_RECEIPTS_SCHEMA_VERSION,
      complete: incompleteReasons.length === 0,
      workspace_url: workspaceUrl,
      tracking_started_at: trackingStartedAt,
      unresolved_intent_count: pendingRows.length,
      incomplete_reasons: incompleteReasons,
      receipts,
    };
  } finally {
    db.close();
  }
}

function parseReceiptBound(
  raw: string | undefined,
  label: "oldest" | "latest",
): { epochMilliseconds: number; iso: string; slackMicroseconds: string } | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  const match = value.match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!match) {
    throw new Error(`Invalid ${label} receipt timestamp: ${raw}`);
  }
  const secondsRaw = match[1]!;
  const seconds = Number(secondsRaw);
  if (!Number.isSafeInteger(seconds)) {
    throw new Error(`Invalid ${label} receipt timestamp: ${raw}`);
  }
  const micros = (match[2] ?? "").padEnd(6, "0");
  const epochMilliseconds = seconds * 1_000 + Number(micros.slice(0, 3));
  return {
    epochMilliseconds,
    iso: new Date(epochMilliseconds).toISOString(),
    slackMicroseconds: `${BigInt(secondsRaw) * 1_000_000n + BigInt(micros)}`,
  };
}

function receiptBoundFromMilliseconds(epochMilliseconds: number): {
  epochMilliseconds: number;
  iso: string;
  slackMicroseconds: string;
} {
  return {
    epochMilliseconds,
    iso: new Date(epochMilliseconds).toISOString(),
    slackMicroseconds: `${BigInt(Math.floor(epochMilliseconds)) * 1_000n}`,
  };
}

function rowToReceipt(row: Record<string, unknown>): SendReceipt {
  const action = requireReceiptAction(requireStoredString(row.action, "action"));
  return compactReceipt({
    channel_id: requireStoredString(row.channel_id, "channel_id"),
    ts: optionalStoredString(row.ts, "ts"),
    scheduled_message_id: optionalStoredString(row.scheduled_message_id, "scheduled_message_id"),
    thread_ts: optionalStoredString(row.thread_ts, "thread_ts"),
    action,
    content_sha256: requireStoredString(row.content_sha256, "content_sha256"),
    canonical_content_sha256: optionalStoredSha256(
      row.canonical_content_sha256,
      "canonical_content_sha256",
    ),
    post_at: optionalStoredNumber(row.post_at, "post_at"),
    recorded_at: requireStoredString(row.recorded_at, "recorded_at"),
  });
}

function rowToIntent(row: Record<string, unknown>): SendReceiptIntent {
  return compactIntent({
    intent_id: requireStoredString(row.intent_id, "intent_id"),
    workspace_url: requireStoredString(row.workspace_url, "workspace_url"),
    channel_id: requireStoredString(row.channel_id, "channel_id"),
    ts: optionalStoredString(row.ts, "ts"),
    thread_ts: optionalStoredString(row.thread_ts, "thread_ts"),
    action: requireReceiptAction(requireStoredString(row.action, "action")),
    content_sha256: requireStoredString(row.content_sha256, "content_sha256"),
    canonical_content_sha256: optionalStoredSha256(
      row.canonical_content_sha256,
      "canonical_content_sha256",
    ),
    post_at: optionalStoredNumber(row.post_at, "post_at"),
    reserved_at: requireStoredString(row.reserved_at, "reserved_at"),
  });
}

function rowToPendingReceipt(row: Record<string, unknown>): SendReceipt {
  const intent = rowToIntent(row);
  return compactReceipt({
    channel_id: intent.channel_id,
    ts: intent.ts,
    thread_ts: intent.thread_ts,
    action: intent.action,
    content_sha256: intent.content_sha256,
    canonical_content_sha256: intent.canonical_content_sha256,
    post_at: intent.post_at,
    recorded_at: intent.reserved_at,
    pending: true,
  });
}

function compactIntent(intent: SendReceiptIntent): SendReceiptIntent {
  return {
    intent_id: intent.intent_id,
    workspace_url: intent.workspace_url,
    channel_id: intent.channel_id,
    ...(intent.ts ? { ts: intent.ts } : {}),
    ...(intent.thread_ts ? { thread_ts: intent.thread_ts } : {}),
    action: intent.action,
    content_sha256: intent.content_sha256,
    ...(intent.canonical_content_sha256
      ? { canonical_content_sha256: intent.canonical_content_sha256 }
      : {}),
    ...(intent.post_at !== undefined ? { post_at: intent.post_at } : {}),
    reserved_at: intent.reserved_at,
  };
}

function compactReceipt(receipt: SendReceipt): SendReceipt {
  return {
    channel_id: receipt.channel_id,
    ...(receipt.ts ? { ts: receipt.ts } : {}),
    ...(receipt.scheduled_message_id ? { scheduled_message_id: receipt.scheduled_message_id } : {}),
    ...(receipt.thread_ts ? { thread_ts: receipt.thread_ts } : {}),
    action: receipt.action,
    content_sha256: receipt.content_sha256,
    ...(receipt.canonical_content_sha256
      ? { canonical_content_sha256: receipt.canonical_content_sha256 }
      : {}),
    ...(receipt.post_at !== undefined ? { post_at: receipt.post_at } : {}),
    recorded_at: receipt.recorded_at,
    ...(receipt.pending ? { pending: true } : {}),
  };
}

function requireNonEmpty(raw: string, label: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error(`Receipt ${label} is required`);
  }
  return value;
}

function optionalNonEmpty(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value || undefined;
}

function optionalSha256(raw: string | undefined, label: string): string | undefined {
  const value = optionalNonEmpty(raw);
  if (value !== undefined && !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Invalid receipt ${label}`);
  }
  return value;
}

function optionalExactSlackTimestamp(raw: string | undefined, label: string): string | undefined {
  const value = optionalNonEmpty(raw);
  if (value === undefined) {
    return undefined;
  }
  const match = value.match(/^(0|[1-9]\d{0,12})\.(\d{6})$/);
  if (!match) {
    throw new Error(`Invalid receipt ${label}: expected an exact Slack timestamp`);
  }
  const seconds = BigInt(match[1]!);
  if (seconds * 1_000n > 8_640_000_000_000_000n) {
    throw new Error(`Invalid receipt ${label}: timestamp is outside the supported date range`);
  }
  return value;
}

function requireReceiptAction(raw: string): ReceiptAction {
  if (!RECEIPT_ACTIONS.has(raw as ReceiptAction)) {
    throw new Error(`Unsupported receipt action: ${raw}`);
  }
  return raw as ReceiptAction;
}

function requireValidDate(date: Date, label: string): Date {
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid receipt ${label}`);
  }
  return date;
}

function requireStoredString(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw) {
    throw new Error(`Invalid send receipt database value for ${label}`);
  }
  return raw;
}

function optionalStoredString(raw: unknown, label: string): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  return requireStoredString(raw, label);
}

function optionalStoredSha256(raw: unknown, label: string): string | undefined {
  const value = optionalStoredString(raw, label);
  if (value !== undefined && !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Invalid send receipt database value for ${label}`);
  }
  return value;
}

function optionalStoredNumber(raw: unknown, label: string): number | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`Invalid send receipt database value for ${label}`);
  }
  return raw;
}

function optionalPostAt(raw: number | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`Invalid receipt postAt: ${raw}`);
  }
  return raw;
}

function closeAfterTransaction(db: { close: () => void }, transactionCommitted: boolean): void {
  try {
    db.close();
  } catch (error) {
    if (!transactionCommitted) {
      throw error;
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
