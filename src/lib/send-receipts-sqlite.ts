import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

type SqliteValue = string | number | null;

type SqliteStatement = {
  run: (...params: SqliteValue[]) => unknown;
  all: (...params: SqliteValue[]) => Record<string, unknown>[];
  get: (...params: SqliteValue[]) => Record<string, unknown> | undefined;
};

export type SendReceiptDatabase = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};

const TRACKING_STARTED_AT_KEY = "tracking_started_at";

export function getSendReceiptsDatabasePath(): string {
  const stateHome = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(stateHome, "agent-slack", "send-receipts.sqlite3");
}

export async function openSendReceiptDatabase(databasePath?: string): Promise<SendReceiptDatabase> {
  const requestedPath = databasePath ?? getSendReceiptsDatabasePath();
  if (!isAbsolute(requestedPath)) {
    throw new Error(`Send receipt database path must be absolute: ${requestedPath}`);
  }
  const dbPath = resolve(requestedPath);
  const dbDir = dirname(dbPath);
  await ensurePrivateStateDirectory(dbDir);
  await ensureRegularDatabaseTarget(dbPath);
  await rejectUnsafeExistingTarget(`${dbPath}-wal`, "SQLite WAL");
  await rejectUnsafeExistingTarget(`${dbPath}-shm`, "SQLite shared-memory file");

  const db = await loadSqliteDatabase(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    inImmediateTransaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS send_receipt_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS send_receipts (
        receipt_key TEXT PRIMARY KEY NOT NULL,
        workspace_url TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        ts TEXT,
        scheduled_message_id TEXT,
        thread_ts TEXT,
        action TEXT NOT NULL CHECK (
          action IN ('send', 'compose_send', 'attachment_send', 'scheduled_send', 'edit')
        ),
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        canonical_content_sha256 TEXT NOT NULL CHECK (length(canonical_content_sha256) = 64),
        post_at INTEGER,
        recorded_at TEXT NOT NULL
      )`);
      ensurePostAtColumn(db);
      ensureReceiptCanonicalContentHashColumn(db);
      db.exec(`CREATE TABLE IF NOT EXISTS send_receipt_intents (
        intent_id TEXT PRIMARY KEY NOT NULL,
        workspace_url TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        ts TEXT,
        thread_ts TEXT,
        action TEXT NOT NULL CHECK (
          action IN ('send', 'compose_send', 'attachment_send', 'scheduled_send', 'edit')
        ),
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        canonical_content_sha256 TEXT NOT NULL CHECK (length(canonical_content_sha256) = 64),
        credential_fingerprint TEXT CHECK (
          credential_fingerprint IS NULL OR length(credential_fingerprint) = 64
        ),
        post_at INTEGER,
        reserved_at TEXT NOT NULL
      )`);
      ensureIntentTsColumn(db);
      ensureIntentCanonicalContentHashColumn(db);
      ensureIntentCredentialFingerprintColumn(db);
      db.exec(`CREATE INDEX IF NOT EXISTS send_receipts_workspace_recorded_at_idx
        ON send_receipts (workspace_url, recorded_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS send_receipt_intents_workspace_reserved_at_idx
        ON send_receipt_intents (workspace_url, reserved_at)`);
      db.prepare(
        `INSERT INTO send_receipt_metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO NOTHING`,
      ).run(TRACKING_STARTED_AT_KEY, new Date().toISOString());
    });
    await enforceSqliteSidecarPermissions(dbPath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function inImmediateTransaction(db: SendReceiptDatabase, work: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

async function loadSqliteDatabase(dbPath: string): Promise<SendReceiptDatabase> {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    const raw = new Database(dbPath, { create: true, strict: true });
    return {
      exec: (sql) => raw.exec(sql),
      prepare: (sql) => {
        const statement = raw.query(sql);
        return {
          run: (...params) => statement.run(...params),
          all: (...params) => statement.all(...params) as Record<string, unknown>[],
          get: (...params) => statement.get(...params) as Record<string, unknown> | undefined,
        };
      },
      close: () => raw.close(),
    };
  }

  // Keep Bun from resolving Node's runtime-only SQLite module while loading
  // this file. Node still resolves the same built-in when this branch runs.
  const nodeSqliteModule = ["node", "sqlite"].join(":");
  const { DatabaseSync } = await import(nodeSqliteModule);
  const raw = new DatabaseSync(dbPath);
  return {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      return {
        run: (...params) => statement.run(...params),
        all: (...params) => statement.all(...params) as Record<string, unknown>[],
        get: (...params) => statement.get(...params) as Record<string, unknown> | undefined,
      };
    },
    close: () => raw.close(),
  };
}

async function enforceSqliteSidecarPermissions(dbPath: string): Promise<void> {
  await Promise.all(
    ["-wal", "-shm"].map(async (suffix) => {
      await secureExistingRegularFile(`${dbPath}${suffix}`, `SQLite ${suffix.slice(1)} file`);
    }),
  );
}

async function ensurePrivateStateDirectory(dbDir: string): Promise<void> {
  const parentDir = dirname(dbDir);
  if (parentDir === dbDir) {
    throw new Error("Send receipt database cannot be stored at the filesystem root");
  }
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  await requireRealDirectory(parentDir, "state parent directory");
  try {
    await mkdir(dbDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  await requireRealDirectory(dbDir, "agent-slack state directory");
  await chmod(dbDir, 0o700);
}

async function requireRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Refusing unsafe ${label}: ${path}`);
  }
  requireCurrentOwner(info.uid, label, path);
}

async function ensureRegularDatabaseTarget(dbPath: string): Promise<void> {
  await rejectUnsafeExistingTarget(dbPath, "send receipt database");
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(dbPath, constants.O_CREAT | constants.O_RDWR | noFollow, 0o600);
  try {
    const info = await handle.stat();
    requireSafeRegularFile(info, "send receipt database", dbPath);
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  await rejectUnsafeExistingTarget(dbPath, "send receipt database");
}

async function rejectUnsafeExistingTarget(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    requireSafeRegularFile(info, label, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function secureExistingRegularFile(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    requireSafeRegularFile(info, label, path);
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await open(path, constants.O_RDWR | noFollow);
    try {
      requireSafeRegularFile(await handle.stat(), label, path);
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function requireSafeRegularFile(
  info: { isFile: () => boolean; isSymbolicLink: () => boolean; uid: number; nlink: number },
  label: string,
  path: string,
): void {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error(`Refusing unsafe ${label}: ${path}`);
  }
  requireCurrentOwner(info.uid, label, path);
}

function requireCurrentOwner(uid: number, label: string, path: string): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && uid !== currentUid) {
    throw new Error(`Refusing ${label} not owned by the current user: ${path}`);
  }
}

function ensurePostAtColumn(db: SendReceiptDatabase): void {
  const columns = db.prepare("PRAGMA table_info(send_receipts)").all();
  if (!columns.some((row) => row.name === "post_at")) {
    db.exec("ALTER TABLE send_receipts ADD COLUMN post_at INTEGER");
  }
}

function ensureIntentTsColumn(db: SendReceiptDatabase): void {
  const columns = db.prepare("PRAGMA table_info(send_receipt_intents)").all();
  if (!columns.some((row) => row.name === "ts")) {
    db.exec("ALTER TABLE send_receipt_intents ADD COLUMN ts TEXT");
  }
}

function ensureReceiptCanonicalContentHashColumn(db: SendReceiptDatabase): void {
  const columns = db.prepare("PRAGMA table_info(send_receipts)").all();
  if (!columns.some((row) => row.name === "canonical_content_sha256")) {
    // Existing receipt databases have no plaintext from which to backfill this
    // safely. Keep legacy rows NULL so listing can fail closed for hash fallback.
    db.exec(
      `ALTER TABLE send_receipts ADD COLUMN canonical_content_sha256 TEXT
       CHECK (canonical_content_sha256 IS NULL OR length(canonical_content_sha256) = 64)`,
    );
  }
}

function ensureIntentCanonicalContentHashColumn(db: SendReceiptDatabase): void {
  const columns = db.prepare("PRAGMA table_info(send_receipt_intents)").all();
  if (!columns.some((row) => row.name === "canonical_content_sha256")) {
    db.exec(
      `ALTER TABLE send_receipt_intents ADD COLUMN canonical_content_sha256 TEXT
       CHECK (canonical_content_sha256 IS NULL OR length(canonical_content_sha256) = 64)`,
    );
  }
}

function ensureIntentCredentialFingerprintColumn(db: SendReceiptDatabase): void {
  const columns = db.prepare("PRAGMA table_info(send_receipt_intents)").all();
  if (!columns.some((row) => row.name === "credential_fingerprint")) {
    db.exec(
      `ALTER TABLE send_receipt_intents ADD COLUMN credential_fingerprint TEXT
       CHECK (credential_fingerprint IS NULL OR length(credential_fingerprint) = 64)`,
    );
  }
}
