import { CREDENTIALS_FILE, KEYCHAIN_SERVICE } from "./paths.ts";
import { writeJsonFile } from "../lib/fs.ts";
import { CredentialsSchema, type Credentials, type Workspace } from "./schema.ts";
import { keychainGet, keychainSet } from "./keychain.ts";
import { platform } from "node:os";
import { readFile } from "node:fs/promises";
import { isRecord } from "../lib/object-type-guards.ts";
import { normalizeSlackWorkspaceUrl } from "../slack/workspace-url.ts";

const KEYCHAIN_PLACEHOLDER = "__KEYCHAIN__";
const LEGACY_BROWSER_COOKIE_ACCOUNT = "xoxd";
const BROWSER_COOKIE_PATTERN = /^xoxd-[A-Za-z0-9%/+_=.-]+$/;
const IS_MACOS = platform() === "darwin";
const INVALID_STORED_CREDENTIALS_ERROR =
  "Stored credentials are invalid; refusing to use or overwrite them.";

function browserCookieAccount(workspaceUrl: string): string {
  return `xoxd:${normalizeSlackWorkspaceUrl(workspaceUrl)}`;
}

function isPlaceholderSecret(value: string | undefined): boolean {
  return !value || value === KEYCHAIN_PLACEHOLDER;
}

function isValidBrowserCookie(value: string | null): value is string {
  return Boolean(value && BROWSER_COOKIE_PATTERN.test(value));
}

export async function readStoredCredentials(
  credentialsFile: string = CREDENTIALS_FILE,
): Promise<Credentials> {
  let raw: string;
  try {
    raw = await readFile(credentialsFile, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { version: 1, workspaces: [] };
    }
    throw error;
  }

  try {
    return CredentialsSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(INVALID_STORED_CREDENTIALS_ERROR);
  }
}

export async function loadCredentials(options?: {
  credentialsFile?: string;
  keychainRead?: typeof keychainGet;
  keychainWrite?: typeof keychainSet;
}): Promise<Credentials> {
  // Optional: hydrate browser cookie/token from keychain for security.
  const creds = await readStoredCredentials(options?.credentialsFile);
  const readKeychain = options?.keychainRead ?? keychainGet;
  const writeKeychain = options?.keychainWrite ?? keychainSet;
  let legacyBrowserCookie: string | null | undefined;
  const readLegacyBrowserCookie = (): string | null => {
    if (legacyBrowserCookie === undefined) {
      const candidate = readKeychain(LEGACY_BROWSER_COOKIE_ACCOUNT, KEYCHAIN_SERVICE);
      legacyBrowserCookie = isValidBrowserCookie(candidate) ? candidate : null;
    }
    return legacyBrowserCookie;
  };
  const hydrated = creds.workspaces.map((w) => {
    if (w.auth.auth_type === "browser") {
      const account = `xoxc:${normalizeSlackWorkspaceUrl(w.workspace_url)}`;
      const xoxc = readKeychain(account, KEYCHAIN_SERVICE);
      const cookieAccount = browserCookieAccount(w.workspace_url);
      let xoxd = readKeychain(cookieAccount, KEYCHAIN_SERVICE);
      if (!xoxd && w.auth.xoxd_cookie === KEYCHAIN_PLACEHOLDER) {
        const legacy = readLegacyBrowserCookie();
        if (legacy) {
          // Older releases stored one session cookie under the global `xoxd` account.
          // Copy only a syntactically valid legacy cookie into this validated workspace scope.
          writeKeychain({ account: cookieAccount, value: legacy, service: KEYCHAIN_SERVICE });
          xoxd = legacy;
        }
      }
      return {
        ...w,
        auth: {
          auth_type: "browser" as const,
          xoxc_token: xoxc ?? w.auth.xoxc_token,
          xoxd_cookie: xoxd ?? w.auth.xoxd_cookie,
        },
      };
    }
    if (w.auth.auth_type === "standard") {
      const account = `token:${normalizeSlackWorkspaceUrl(w.workspace_url)}`;
      const token = readKeychain(account, KEYCHAIN_SERVICE);
      return {
        ...w,
        auth: {
          auth_type: "standard" as const,
          token: token ?? w.auth.token,
        },
      };
    }
    return w;
  });

  return { ...creds, workspaces: hydrated };
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  const payload = CredentialsSchema.parse({
    ...credentials,
    updated_at: new Date().toISOString(),
  });

  // Store secrets in keychain when possible and avoid writing plaintext tokens to disk.
  // If keychain writes fail (or non-macOS), fall back to storing secrets in the file.
  const filePayload: Credentials = structuredClone(payload);

  if (IS_MACOS) {
    for (const w of filePayload.workspaces) {
      if (w.auth.auth_type === "browser") {
        const account = `xoxc:${normalizeSlackWorkspaceUrl(w.workspace_url)}`;
        const tokenStored =
          isPlaceholderSecret(w.auth.xoxc_token) ||
          keychainGet(account, KEYCHAIN_SERVICE) === w.auth.xoxc_token ||
          keychainSet({ account, value: w.auth.xoxc_token, service: KEYCHAIN_SERVICE });
        const cookieAccount = browserCookieAccount(w.workspace_url);
        const cookieStored =
          isPlaceholderSecret(w.auth.xoxd_cookie) ||
          keychainGet(cookieAccount, KEYCHAIN_SERVICE) === w.auth.xoxd_cookie ||
          keychainSet({
            account: cookieAccount,
            value: w.auth.xoxd_cookie,
            service: KEYCHAIN_SERVICE,
          });

        if (tokenStored) {
          w.auth.xoxc_token = KEYCHAIN_PLACEHOLDER;
        }
        if (cookieStored) {
          w.auth.xoxd_cookie = KEYCHAIN_PLACEHOLDER;
        }
      }

      if (w.auth.auth_type === "standard") {
        const account = `token:${normalizeSlackWorkspaceUrl(w.workspace_url)}`;
        const tokenStored =
          isPlaceholderSecret(w.auth.token) ||
          keychainGet(account, KEYCHAIN_SERVICE) === w.auth.token ||
          keychainSet({ account, value: w.auth.token, service: KEYCHAIN_SERVICE });
        if (tokenStored) {
          w.auth.token = KEYCHAIN_PLACEHOLDER;
        }
      }
    }
  }

  await writeJsonFile(CREDENTIALS_FILE, filePayload);
}

export async function upsertWorkspace(workspace: Workspace): Promise<Workspace> {
  const creds = await loadCredentials();
  const normalizedUrl = normalizeSlackWorkspaceUrl(workspace.workspace_url);
  const next: Workspace = { ...workspace, workspace_url: normalizedUrl };

  const idx = creds.workspaces.findIndex((w) => w.workspace_url === normalizedUrl);
  if (idx === -1) {
    creds.workspaces.push(next);
  } else {
    creds.workspaces[idx] = {
      ...creds.workspaces[idx],
      ...next,
      auth: next.auth,
    };
  }

  if (!creds.default_workspace_url) {
    creds.default_workspace_url = normalizedUrl;
  }
  await saveCredentials(creds);
  return next;
}

export async function upsertWorkspaces(workspaces: Workspace[]): Promise<void> {
  if (workspaces.length === 0) {
    return;
  }
  const creds = await loadCredentials();

  for (const workspace of workspaces) {
    const normalizedUrl = normalizeSlackWorkspaceUrl(workspace.workspace_url);
    const next: Workspace = { ...workspace, workspace_url: normalizedUrl };

    const idx = creds.workspaces.findIndex((w) => w.workspace_url === normalizedUrl);
    if (idx === -1) {
      creds.workspaces.push(next);
    } else {
      creds.workspaces[idx] = {
        ...creds.workspaces[idx],
        ...next,
        auth: next.auth,
      };
    }

    if (!creds.default_workspace_url) {
      creds.default_workspace_url = normalizedUrl;
    }
  }

  await saveCredentials(creds);
}

export async function setDefaultWorkspace(workspaceUrl: string): Promise<void> {
  const creds = await loadCredentials();
  creds.default_workspace_url = normalizeSlackWorkspaceUrl(workspaceUrl);
  await saveCredentials(creds);
}

export async function removeWorkspace(workspaceUrl: string): Promise<void> {
  const creds = await loadCredentials();
  const normalized = normalizeSlackWorkspaceUrl(workspaceUrl);
  creds.workspaces = creds.workspaces.filter((w) => w.workspace_url !== normalized);
  if (creds.default_workspace_url === normalized) {
    creds.default_workspace_url = creds.workspaces[0]?.workspace_url;
  }
  await saveCredentials(creds);
}

export async function resolveWorkspaceForUrl(workspaceUrl: string): Promise<Workspace | null> {
  const creds = await loadCredentials();
  const normalized = normalizeSlackWorkspaceUrl(workspaceUrl);
  return creds.workspaces.find((w) => w.workspace_url === normalized) ?? null;
}

export async function resolveDefaultWorkspace(): Promise<Workspace | null> {
  const creds = await loadCredentials();
  if (creds.default_workspace_url) {
    const byDefault = creds.workspaces.find((w) => w.workspace_url === creds.default_workspace_url);
    if (byDefault) {
      return byDefault;
    }
  }
  return creds.workspaces[0] ?? null;
}

// (reserved for future non-secret per-workspace metadata)
