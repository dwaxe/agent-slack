import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  FORK_RELEASE_REPO,
  UPSTREAM_RELEASE_REPO,
  compareSemver,
  fetchLatestVersion,
  isForkBuildVersion,
  isUpdateInstallSupported,
  selectLatestReleaseVersion,
  performUpdate,
  updateSourceForVersion,
} from "../src/lib/update.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installableAssets(): { name: string; browser_download_url: string }[] {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const extension = process.platform === "win32" ? ".exe" : "";
  return [
    {
      name: `agent-slack-${platform}-${arch}${extension}`,
      browser_download_url: "https://example.invalid/binary",
    },
    {
      name: "checksums-sha256.txt",
      browser_download_url: "https://example.invalid/sums",
    },
  ];
}

describe("compareSemver", () => {
  test("equal versions return 0", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  test("strips v prefix", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
  });

  test("newer major", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });

  test("newer minor", () => {
    expect(compareSemver("1.3.0", "1.2.9")).toBeGreaterThan(0);
  });

  test("newer patch", () => {
    expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
  });

  test("older version returns negative", () => {
    expect(compareSemver("0.1.0", "0.2.0")).toBeLessThan(0);
  });

  test("handles 0.x versions", () => {
    expect(compareSemver("0.2.10", "0.2.9")).toBeGreaterThan(0);
    expect(compareSemver("0.2.10", "0.2.10")).toBe(0);
    expect(compareSemver("0.2.10", "0.3.0")).toBeLessThan(0);
  });

  test("orders dwaxe build revisions and upstream base versions", () => {
    expect(compareSemver("0.10.2-dwaxe.18", "0.10.2-dwaxe.17")).toBeGreaterThan(0);
    expect(compareSemver("0.10.3-dwaxe.0", "0.10.2-dwaxe.99")).toBeGreaterThan(0);
  });

  test("rejects malformed versions", () => {
    expect(() => compareSemver("0.10", "0.10.2")).toThrow("Invalid agent-slack version");
  });
});

describe("fork update source", () => {
  test("routes dwaxe builds only to the personal release repository", () => {
    expect(isForkBuildVersion("0.10.2-dwaxe.14")).toBe(true);
    expect(updateSourceForVersion("0.10.2-dwaxe.14")).toEqual({
      channel: "fork",
      repo: FORK_RELEASE_REPO,
    });
  });

  test("routes upstream and unrelated prerelease builds only to upstream", () => {
    expect(isForkBuildVersion("0.10.2")).toBe(false);
    expect(isForkBuildVersion("0.10.3-rc.1")).toBe(false);
    expect(updateSourceForVersion("0.10.3-rc.1")).toEqual({
      channel: "upstream",
      repo: UPSTREAM_RELEASE_REPO,
    });
  });

  test("allows fork updates only for standalone binaries", () => {
    expect(isUpdateInstallSupported("fork", "binary")).toBe(true);
    expect(isUpdateInstallSupported("fork", "npm")).toBe(false);
    expect(isUpdateInstallSupported("fork", "bun")).toBe(false);
    expect(isUpdateInstallSupported("upstream", "npm")).toBe(true);
  });

  test("fails closed for malformed dwaxe build identifiers", () => {
    expect(() => updateSourceForVersion("0.10.2-dwaxe.beta")).toThrow("Invalid dwaxe fork version");
    expect(() => updateSourceForVersion("0.10.2-dwaxe.17.1")).toThrow("Invalid dwaxe fork version");
  });

  test("selects the newest installable release in the requested channel", () => {
    const assets = installableAssets();
    const releases = [
      { tag_name: "v0.10.2-dwaxe.17", assets },
      { tag_name: "v0.10.3", assets },
      { tag_name: "v0.10.2-dwaxe.19", draft: true, assets },
      { tag_name: "v0.10.2-dwaxe.18", assets },
      { tag_name: "v0.10.2-dwaxe.20", assets: [] },
      { tag_name: "0.10.2-dwaxe.99", assets },
    ];

    expect(selectLatestReleaseVersion(releases, "fork")).toBe("0.10.2-dwaxe.18");
    expect(selectLatestReleaseVersion(releases, "upstream")).toBe("0.10.3");
  });

  test("queries prerelease-capable fork releases for dwaxe builds", async () => {
    const fetchMock = mock(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify([{ tag_name: "v0.10.2-dwaxe.18", assets: installableAssets() }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchLatestVersion("0.10.2-dwaxe.17")).resolves.toBe("0.10.2-dwaxe.18");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/dwaxe/agent-slack/releases?per_page=100",
    );
  });

  test("will not cross release repositories during installation", async () => {
    await expect(performUpdate("0.10.2-dwaxe.18", UPSTREAM_RELEASE_REPO)).resolves.toEqual({
      success: false,
      message: "Release 0.10.2-dwaxe.18 does not belong to stablyai/agent-slack",
    });
    await expect(performUpdate("../../collector", FORK_RELEASE_REPO)).resolves.toEqual({
      success: false,
      message: "Invalid agent-slack release version: ../../collector",
    });
  });

  test("downloads fork assets only from the pinned fork release", async () => {
    const urls: string[] = [];
    const fetchMock = mock(async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response("missing", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await performUpdate("0.10.2-dwaxe.18", FORK_RELEASE_REPO);

    expect(result.success).toBe(false);
    expect(urls).toHaveLength(2);
    expect(
      urls.every((url) =>
        url.startsWith("https://github.com/dwaxe/agent-slack/releases/download/v0.10.2-dwaxe.18/"),
      ),
    ).toBe(true);
  });
});
