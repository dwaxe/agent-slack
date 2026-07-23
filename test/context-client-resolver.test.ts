import { afterEach, describe, expect, test } from "bun:test";
import { getClientForWorkspace } from "../src/cli/context-client-resolver.ts";

const originalSlackEnv = {
  token: process.env.SLACK_TOKEN,
  cookieD: process.env.SLACK_COOKIE_D,
  workspaceUrl: process.env.SLACK_WORKSPACE_URL,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv("SLACK_TOKEN", originalSlackEnv.token);
  restoreEnv("SLACK_COOKIE_D", originalSlackEnv.cookieD);
  restoreEnv("SLACK_WORKSPACE_URL", originalSlackEnv.workspaceUrl);
});

describe("environment workspace validation", () => {
  test("rejects an unsafe origin before returning a browser client", async () => {
    process.env.SLACK_TOKEN = "xoxc-test";
    process.env.SLACK_COOKIE_D = "xoxd-test";
    process.env.SLACK_WORKSPACE_URL = "https://collector.example";

    await expect(getClientForWorkspace()).rejects.toThrow(
      "canonical HTTPS Slack or GovSlack origin",
    );
  });

  test("canonicalizes a GovSlack origin for standard tokens", async () => {
    process.env.SLACK_TOKEN = "xoxb-test";
    process.env.SLACK_WORKSPACE_URL = "https://AGENCY.slack-gov.com/";

    await expect(getClientForWorkspace()).resolves.toMatchObject({
      workspace_url: "https://agency.slack-gov.com",
      auth: { auth_type: "standard" },
    });
  });

  test("does not validate an unused env URL when an explicit workspace wins", async () => {
    process.env.SLACK_TOKEN = "xoxb-test";
    process.env.SLACK_WORKSPACE_URL = "https://collector.example";

    await expect(getClientForWorkspace("https://workspace.slack.com")).resolves.toMatchObject({
      workspace_url: "https://workspace.slack.com",
      auth: { auth_type: "standard" },
    });
  });
});
