import { readFile, stat, realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB — Slack's upload limit

export type SlackFileUploadResult = {
  file_id: string;
  channel_id: string;
  ts?: string;
  thread_ts?: string;
};

export async function uploadLocalFileToSlack(input: {
  client: SlackApiClient;
  channelId: string;
  filePath: string;
  threadTs?: string;
  initialComment?: string;
  beforeUpload?: () => Promise<void>;
  beforeComplete?: () => Promise<void>;
}): Promise<SlackFileUploadResult> {
  const resolvedPath = await realpath(input.filePath);
  const fileStats = await stat(resolvedPath);
  if (!fileStats.isFile()) {
    throw new Error(`Attachment path is not a file: ${input.filePath}`);
  }
  if (fileStats.size > MAX_FILE_SIZE) {
    throw new Error(
      `File too large (${Math.round(fileStats.size / 1024 / 1024)}MB). Slack allows up to 100MB.`,
    );
  }

  const bytes = await readFile(resolvedPath);
  const filename = basename(resolvedPath);

  await input.beforeUpload?.();

  const uploadInitResp = await input.client.api("files.getUploadURLExternal", {
    filename,
    length: bytes.length,
  });

  if (isRecord(uploadInitResp) && uploadInitResp.ok === false) {
    const errMsg = typeof uploadInitResp.error === "string" ? uploadInitResp.error : "unknown";
    throw new Error(`Slack files.getUploadURLExternal failed: ${errMsg}`);
  }

  const uploadUrl = getString(uploadInitResp.upload_url);
  const fileId = getString(uploadInitResp.file_id);
  if (!uploadUrl || !fileId) {
    throw new Error("Slack did not return an upload URL for file attachment");
  }

  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
    },
    body: bytes,
  });
  if (!uploadResp.ok) {
    const body = await uploadResp.text().catch(() => "");
    throw new Error(
      `Failed to upload attachment bytes (HTTP ${uploadResp.status})${body ? `: ${body}` : ""}`,
    );
  }

  await input.beforeComplete?.();

  const completeResp = await input.client.api("files.completeUploadExternal", {
    files: [{ id: fileId, title: filename }],
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    initial_comment: input.initialComment?.trim() || undefined,
  });

  if (!isRecord(completeResp) || completeResp.ok !== true) {
    const errMsg =
      isRecord(completeResp) && typeof completeResp.error === "string"
        ? completeResp.error
        : "unknown";
    throw new Error(`Slack files.completeUploadExternal failed: ${errMsg}`);
  }

  const shareIdentity = findUploadShareIdentity(completeResp, input.channelId);
  return {
    file_id: fileId,
    channel_id: shareIdentity?.channel_id ?? input.channelId,
    ...(shareIdentity?.ts ? { ts: shareIdentity.ts } : {}),
    ...(shareIdentity?.thread_ts
      ? { thread_ts: shareIdentity.thread_ts }
      : input.threadTs
        ? { thread_ts: input.threadTs }
        : {}),
  };
}

function findUploadShareIdentity(
  completeResp: Record<string, unknown>,
  requestedChannelId: string,
): { channel_id: string; ts?: string; thread_ts?: string } | undefined {
  for (const file of asArray(completeResp.files)) {
    if (!isRecord(file) || !isRecord(file.shares)) {
      continue;
    }
    for (const visibility of ["public", "private"] as const) {
      const shares = file.shares[visibility];
      if (!isRecord(shares)) {
        continue;
      }
      const channelEntries = asArray(shares[requestedChannelId]);
      for (const entry of channelEntries) {
        if (!isRecord(entry)) {
          continue;
        }
        const ts = getString(entry.ts);
        const threadTs = getString(entry.thread_ts);
        if (ts || threadTs) {
          return {
            channel_id: requestedChannelId,
            ...(ts ? { ts } : {}),
            ...(threadTs ? { thread_ts: threadTs } : {}),
          };
        }
      }
    }
  }
  return undefined;
}
