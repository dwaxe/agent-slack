import { describe, expect, test } from "bun:test";
import { compareSemver, isUpstreamSelfUpdateDisabled } from "../src/lib/update.ts";

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
});

describe("isUpstreamSelfUpdateDisabled", () => {
  test("protects dwaxe fork builds from upstream replacement", () => {
    expect(isUpstreamSelfUpdateDisabled("0.10.2-dwaxe.14")).toBe(true);
  });

  test("leaves upstream and unrelated prerelease builds updateable", () => {
    expect(isUpstreamSelfUpdateDisabled("0.10.2")).toBe(false);
    expect(isUpstreamSelfUpdateDisabled("0.10.3-rc.1")).toBe(false);
  });
});
