import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAppDir } from "../lib/app-dir.ts";
import { readJsonFile } from "../lib/fs.ts";
import { asArray, isRecord } from "../lib/object-type-guards.ts";
import type { SlackApiClient } from "./client.ts";
import type { SlackMessageSummary } from "./messages.ts";
import { toCompactUser, type CompactSlackUser } from "./users.ts";
import { isUserId } from "./user-id.ts";

const CACHE_VERSION = 2;
const USER_TTL_MS = 24 * 60 * 60 * 1000;
const USER_MENTION_PATTERN = /<@([^>|]+)(?:\|[^>]*)?>/g;

type UserCacheEntry = {
  fetched_at: number;
  user: CompactSlackUser;
};

type UserCacheFile = {
  version: number;
  scope: string;
  entries: Record<string, UserCacheEntry>;
};

type ResolveUsersInput = {
  client: SlackApiClient;
  workspaceUrl: string;
  userIds: string[];
  forceRefresh?: boolean;
};

export async function resolveUsersById(
  input: ResolveUsersInput,
): Promise<Map<string, CompactSlackUser>> {
  return resolveUsersByIdInternal(input, false);
}

async function resolveUsersByIdInternal(
  input: ResolveUsersInput,
  throwOnError: boolean,
): Promise<Map<string, CompactSlackUser>> {
  const uniqueIds = dedupeUserIds(input.userIds);
  if (uniqueIds.length === 0) {
    return new Map<string, CompactSlackUser>();
  }

  const forceRefresh = input.forceRefresh ?? false;
  const now = Date.now();
  const workspaceKey = hashWorkspaceUrl(input.workspaceUrl);
  const isUnknownWorkspace = workspaceKey === "unknown";
  const cacheScope = input.client.cacheScopeKey();
  const cachePath = isUnknownWorkspace ? "" : join(getAppDir(), `users-cache-${workspaceKey}.json`);

  const diskCache = cachePath
    ? await loadCacheBestEffort(cachePath, { now, scope: cacheScope })
    : emptyCache(cacheScope);
  const out = new Map<string, CompactSlackUser>();
  const missing: string[] = [];
  let cacheChanged = false;

  for (const userId of uniqueIds) {
    const cached = diskCache.entries[userId];
    if (!forceRefresh && cached && now - cached.fetched_at < USER_TTL_MS) {
      out.set(userId, cached.user);
      continue;
    }
    missing.push(userId);
  }

  if (missing.length > 0) {
    const fetched: { userId: string; user: CompactSlackUser | undefined }[] = [];
    const concurrency = 5;
    for (let i = 0; i < missing.length; i += concurrency) {
      const chunk = missing.slice(i, i + concurrency);
      const results = await Promise.all(
        chunk.map(async (userId) => ({
          userId,
          user: await fetchUserById({
            client: input.client,
            userId,
            throwOnError,
          }),
        })),
      );
      fetched.push(...results);
    }

    for (const item of fetched) {
      if (!item.user) {
        continue;
      }
      const entry: UserCacheEntry = {
        fetched_at: now,
        user: item.user,
      };
      diskCache.entries[item.userId] = entry;
      out.set(item.userId, item.user);
      cacheChanged = true;
    }
  }

  if (cachePath) {
    const prunedCache = pruneExpiredEntries(diskCache, now);
    if (Object.keys(diskCache.entries).length !== Object.keys(prunedCache.entries).length) {
      cacheChanged = true;
    }
    if (cacheChanged) {
      await writeCache(cachePath, prunedCache);
    }
  }

  return out;
}

export async function getCachedUserById(input: {
  client: SlackApiClient;
  userId: string;
  workspaceUrl: string;
  forceRefresh?: boolean;
}): Promise<CompactSlackUser | undefined> {
  const userId = input.userId.trim();
  const users = await resolveUsersByIdInternal(
    {
      client: input.client,
      workspaceUrl: input.workspaceUrl,
      userIds: [userId],
      forceRefresh: input.forceRefresh,
    },
    true,
  );
  return users.get(userId);
}

export function collectReferencedUserIds(
  messages: SlackMessageSummary[],
  options?: { includeReactions?: boolean },
): string[] {
  const ids = new Set<string>();
  const includeReactions = options?.includeReactions ?? false;
  for (const message of messages) {
    collectUserIdsFromMessage(message, ids, { includeReactions });
  }
  return Array.from(ids);
}

export function toReferencedUsers(
  userIds: string[],
  usersById: Map<string, CompactSlackUser>,
): Record<string, CompactSlackUser> | undefined {
  const out: Record<string, CompactSlackUser> = {};
  for (const userId of dedupeUserIds(userIds)) {
    const user = usersById.get(userId);
    if (!user) {
      continue;
    }
    out[userId] = user;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function dedupeUserIds(ids: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of ids) {
    const userId = String(raw).trim();
    if (!isUserId(userId)) {
      continue;
    }
    seen.add(userId);
  }
  return Array.from(seen);
}

function hashWorkspaceUrl(workspaceUrl: string): string {
  const trimmed = workspaceUrl.trim();
  if (!trimmed) {
    return "unknown";
  }

  let source = trimmed;
  try {
    source = new URL(trimmed).hostname.toLowerCase();
  } catch {
    source = trimmed.toLowerCase();
  }

  if (!source || source === "unknown") {
    return "unknown";
  }

  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function emptyCache(scope: string): UserCacheFile {
  return { version: CACHE_VERSION, scope, entries: {} };
}

async function loadCacheBestEffort(
  path: string,
  options: { now: number; scope: string },
): Promise<UserCacheFile> {
  try {
    return await loadCache(path, options);
  } catch {
    return emptyCache(options.scope);
  }
}

async function loadCache(
  path: string,
  options: { now: number; scope: string },
): Promise<UserCacheFile> {
  const file = await readJsonFile<UserCacheFile>(path);
  if (!file) {
    return emptyCache(options.scope);
  }
  if (file.version !== CACHE_VERSION || file.scope !== options.scope || !isRecord(file.entries)) {
    await rm(path, { force: true });
    return emptyCache(options.scope);
  }

  const entries: Record<string, UserCacheEntry> = {};
  for (const [userId, rawEntry] of Object.entries(file.entries)) {
    if (!isUserId(userId) || !isRecord(rawEntry)) {
      continue;
    }
    const fetchedAt = typeof rawEntry.fetched_at === "number" ? rawEntry.fetched_at : undefined;
    const user = isRecord(rawEntry.user)
      ? toCompactUser({ ...rawEntry.user, profile: rawEntry.user })
      : null;
    if (
      !fetchedAt ||
      !Number.isFinite(fetchedAt) ||
      fetchedAt > options.now ||
      !user ||
      user.id !== userId
    ) {
      continue;
    }
    entries[userId] = { fetched_at: fetchedAt, user };
  }

  return {
    version: CACHE_VERSION,
    scope: options.scope,
    entries,
  };
}

async function writeCache(path: string, file: UserCacheFile): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tempPath, path);
  } catch {
    // Cache writes are best effort.
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

function pruneExpiredEntries(file: UserCacheFile, now: number): UserCacheFile {
  const next: Record<string, UserCacheEntry> = {};
  for (const [userId, entry] of Object.entries(file.entries)) {
    if (now - entry.fetched_at >= USER_TTL_MS) {
      continue;
    }
    next[userId] = entry;
  }
  return { version: CACHE_VERSION, scope: file.scope, entries: next };
}

async function fetchUserById(input: {
  client: SlackApiClient;
  userId: string;
  throwOnError: boolean;
}): Promise<CompactSlackUser | undefined> {
  try {
    const resp = await input.client.api("users.info", { user: input.userId });
    const user = isRecord(resp.user) ? resp.user : null;
    if (!user) {
      return undefined;
    }
    const compact = toCompactUser(user);
    return compact.id === input.userId ? compact : undefined;
  } catch (error) {
    if (input.throwOnError) {
      throw error;
    }
    return undefined;
  }
}

function collectUserIdsFromUnknown(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    collectMentionUserIds(value, out);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUserIdsFromUnknown(item, out);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if ((key === "user" || key === "user_id") && typeof child === "string") {
      if (isUserId(child)) {
        out.add(child);
      }
      continue;
    }

    if (key === "users") {
      for (const maybeUserId of asArray(child)) {
        const userId = String(maybeUserId);
        if (isUserId(userId)) {
          out.add(userId);
        }
      }
      continue;
    }

    collectUserIdsFromUnknown(child, out);
  }
}

function collectUserIdsFromMessage(
  message: SlackMessageSummary,
  out: Set<string>,
  options: { includeReactions: boolean },
): void {
  if (message.user && isUserId(message.user)) {
    out.add(message.user);
  }

  if (typeof message.text === "string") {
    collectMentionUserIds(message.text, out);
  }

  collectUserIdsFromUnknown(message.blocks, out);
  collectUserIdsFromUnknown(message.attachments, out);

  if (options.includeReactions) {
    collectUserIdsFromUnknown(message.reactions, out);
  }
}

function collectMentionUserIds(text: string, out: Set<string>): void {
  USER_MENTION_PATTERN.lastIndex = 0;
  for (;;) {
    const match = USER_MENTION_PATTERN.exec(text);
    if (!match) {
      break;
    }
    const userId = match[1] ?? "";
    if (isUserId(userId)) {
      out.add(userId);
    }
  }
}
