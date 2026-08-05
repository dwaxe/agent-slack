import { afterEach, describe, expect, mock, test } from "bun:test";
import { SlackApiClient } from "../src/slack/client.ts";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  delete process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS;
});

describe("SlackApiClient credential identity", () => {
  test("returns a stable one-way fingerprint scoped to the exact credential", () => {
    const first = new SlackApiClient({ auth_type: "standard", token: "xoxb-secret-one" });
    const same = new SlackApiClient({ auth_type: "standard", token: "xoxb-secret-one" });
    const different = new SlackApiClient({ auth_type: "standard", token: "xoxb-secret-two" });

    expect(first.credentialFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(first.credentialFingerprint()).toBe(same.credentialFingerprint());
    expect(first.credentialFingerprint()).not.toBe(different.credentialFingerprint());
    expect(first.credentialFingerprint()).not.toContain("secret");
  });
});

function browserAuth() {
  return {
    auth_type: "browser" as const,
    xoxc_token: "xoxc-test",
    xoxd_cookie: "xoxd-test",
  };
}

describe("SlackApiClient credential destinations", () => {
  test("rejects unsafe workspace origins before browser credentials can be sent", () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(
      () => new SlackApiClient(browserAuth(), { workspaceUrl: "https://collector.example" }),
    ).toThrow("canonical HTTPS Slack or GovSlack origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("revalidates immediately before both browser transports", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SlackApiClient(browserAuth(), {
      workspaceUrl: "https://workspace.slack.com",
    });

    (client as unknown as { workspaceUrl: string }).workspaceUrl = "https://collector.example";

    await expect(client.api("auth.test")).rejects.toThrow(
      "canonical HTTPS Slack or GovSlack origin",
    );
    await expect(client.apiMultipart("files.createCanvas")).rejects.toThrow(
      "canonical HTTPS Slack or GovSlack origin",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uses GovSlack browser and standard-token destinations", async () => {
    const fetchMock = mock(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const browserClient = new SlackApiClient(browserAuth(), {
      workspaceUrl: "https://AGENCY.slack-gov.com/",
    });

    await expect(browserClient.api("auth.test")).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://agency.slack-gov.com/api/auth.test");
    expect(init).toMatchObject({
      redirect: "error",
      headers: { Origin: "https://app.slack-gov.com" },
    });

    const standardClient = new SlackApiClient(
      { auth_type: "standard", token: "xoxb-test" },
      { workspaceUrl: "https://agency.slack-gov.com" },
    );
    expect((standardClient as unknown as { web: { slackApiUrl: string } }).web.slackApiUrl).toBe(
      "https://slack-gov.com/api/",
    );
  });
});

describe("SlackApiClient cache scope", () => {
  test("changes when either browser credential changes", () => {
    const first = new SlackApiClient({
      auth_type: "browser",
      xoxc_token: "xoxc-first",
      xoxd_cookie: "xoxd-first",
    });
    const same = new SlackApiClient({
      auth_type: "browser",
      xoxc_token: "xoxc-first",
      xoxd_cookie: "xoxd-first",
    });
    const rotatedCookie = new SlackApiClient({
      auth_type: "browser",
      xoxc_token: "xoxc-first",
      xoxd_cookie: "xoxd-second",
    });

    expect(first.cacheScopeKey()).toBe(same.cacheScopeKey());
    expect(first.cacheScopeKey()).not.toBe(rotatedCookie.cacheScopeKey());
    expect(first.cacheScopeKey()).not.toContain("xoxc-first");
    expect(first.cacheScopeKey()).not.toContain("xoxd-first");
  });
});

describe("SlackApiClient browser multipart transport", () => {
  test("retries HTTP 429 responses using Retry-After", async () => {
    // Fail-fast defaults to 0ms; opt in to waiting so the retry path runs.
    process.env.AGENT_SLACK_RATE_LIMIT_MAX_WAIT_MS = "30000";
    const responses = [
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "2" },
      }),
      new Response(JSON.stringify({ ok: true, file_id: "F12345678" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ];
    const fetchMock = mock(async (_input: string | URL | Request, _init?: RequestInit) => {
      return responses.shift()!;
    });
    const delays: number[] = [];
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      callback();
      return 0;
    }) as unknown as typeof setTimeout;

    const client = new SlackApiClient(browserAuth(), {
      workspaceUrl: "https://workspace.slack.com",
    });

    await expect(
      client.apiMultipart("files.createCanvas", {
        title: "Launch plan",
        markdown: "# Launch plan\n",
      }),
    ).resolves.toEqual({ ok: true, file_id: "F12345678" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2000]);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.body).toBeInstanceOf(FormData);
      expect(call[1]?.redirect).toBe("error");
    }
  });
});
