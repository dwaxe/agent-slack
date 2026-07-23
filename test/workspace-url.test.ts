import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialsSchema, WorkspaceSchema } from "../src/auth/schema.ts";
import { loadCredentials, readStoredCredentials } from "../src/auth/store.ts";
import {
  normalizeSlackWorkspaceUrl,
  slackApiUrlForWorkspace,
  slackAppOriginForWorkspace,
} from "../src/slack/workspace-url.ts";

describe("Slack workspace origins", () => {
  test("canonicalizes commercial, Enterprise, and GovSlack origins", () => {
    expect(normalizeSlackWorkspaceUrl("https://TEAM.slack.com/")).toBe("https://team.slack.com");
    expect(normalizeSlackWorkspaceUrl("https://acme.enterprise.slack.com")).toBe(
      "https://acme.enterprise.slack.com",
    );
    expect(normalizeSlackWorkspaceUrl("https://AGENCY.slack-gov.com/")).toBe(
      "https://agency.slack-gov.com",
    );
  });

  test("rejects origins outside the Slack credential boundary", () => {
    for (const value of [
      "http://team.slack.com",
      "https://example.com",
      "https://team.slack.com.evil.test",
      "https://slack.com",
      "https://user:password@team.slack.com",
      "https://team.slack.com:8443",
      "https://team.slack.com/archives/C123",
      "https://team.slack.com?token=secret",
      "https://team.slack.com#fragment",
    ]) {
      expect(() => normalizeSlackWorkspaceUrl(value), value).toThrow(
        "canonical HTTPS Slack or GovSlack origin",
      );
    }
  });

  test("routes each accepted realm to its fixed app and API origins", () => {
    expect(slackAppOriginForWorkspace("https://team.slack.com")).toBe("https://app.slack.com");
    expect(slackApiUrlForWorkspace("https://team.slack.com")).toBe("https://slack.com/api/");
    expect(slackAppOriginForWorkspace("https://agency.slack-gov.com")).toBe(
      "https://app.slack-gov.com",
    );
    expect(slackApiUrlForWorkspace("https://agency.slack-gov.com")).toBe(
      "https://slack-gov.com/api/",
    );
  });
});

describe("credential ingestion", () => {
  const browserAuth = {
    auth_type: "browser" as const,
    xoxc_token: "xoxc-test",
    xoxd_cookie: "xoxd-test",
  };

  test("canonicalizes valid workspace records and rejects a mixed unsafe store", () => {
    expect(
      WorkspaceSchema.parse({ workspace_url: "https://TEAM.slack.com/", auth: browserAuth })
        .workspace_url,
    ).toBe("https://team.slack.com");
    expect(
      CredentialsSchema.safeParse({
        version: 1,
        workspaces: [
          { workspace_url: "https://team.slack.com", auth: browserAuth },
          { workspace_url: "https://team.slack.com.evil.test", auth: browserAuth },
        ],
      }).success,
    ).toBe(false);
  });

  test("keeps an irrelevant legacy default from invalidating safe workspaces", () => {
    expect(
      CredentialsSchema.parse({
        version: 1,
        default_workspace_url: "http://legacy.slack.com",
        workspaces: [{ workspace_url: "https://TEAM.slack.com/", auth: browserAuth }],
      }),
    ).toMatchObject({
      default_workspace_url: "http://legacy.slack.com",
      workspaces: [{ workspace_url: "https://team.slack.com" }],
    });
  });

  test("hydrates only workspace-scoped browser cookies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-credentials-"));
    const credentialsFile = join(dir, "credentials.json");
    const browserWorkspace = (workspace_url: string) => ({
      workspace_url,
      auth: {
        auth_type: "browser" as const,
        xoxc_token: "xoxc-file",
        xoxd_cookie: "__KEYCHAIN__",
      },
    });
    const keychain = new Map([
      ["xoxd", "xoxd-unscoped-legacy"],
      ["xoxd:https://team.slack.com", "xoxd-commercial"],
      ["xoxd:https://agency.slack-gov.com", "xoxd-gov"],
    ]);

    try {
      await writeFile(
        credentialsFile,
        JSON.stringify({
          version: 1,
          workspaces: [
            browserWorkspace("https://team.slack.com"),
            browserWorkspace("https://agency.slack-gov.com"),
            browserWorkspace("https://legacy-only.slack.com"),
          ],
        }),
      );

      const credentials = await loadCredentials({
        credentialsFile,
        keychainRead: (account) => keychain.get(account) ?? null,
      });

      expect(
        credentials.workspaces.map((workspace) =>
          workspace.auth.auth_type === "browser" ? workspace.auth.xoxd_cookie : null,
        ),
      ).toEqual(["xoxd-commercial", "xoxd-gov", "__KEYCHAIN__"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses malformed stored credentials without overwriting them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-slack-credentials-"));
    const credentialsFile = join(dir, "credentials.json");
    try {
      await writeFile(credentialsFile, "{not-json");
      await expect(readStoredCredentials(credentialsFile)).rejects.toThrow(
        "refusing to use or overwrite",
      );
      expect(await readFile(credentialsFile, "utf8")).toBe("{not-json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
