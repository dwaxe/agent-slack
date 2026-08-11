/** Normalize the Q-prefixed API ID and numeric list ID to one local identity. */
export function normalizeSlackScheduledMessageId(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Invalid Slack scheduled message ID");
    }
    return String(value);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Invalid Slack scheduled message ID");
  }
  return /^Q(\d+)$/i.exec(trimmed)?.[1] ?? trimmed;
}

export function slackScheduledMessageApiId(value: string | number): string {
  const normalized = normalizeSlackScheduledMessageId(value);
  return /^\d+$/.test(normalized) ? `Q${normalized}` : normalized;
}
