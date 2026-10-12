import { describe, expect, it } from "vitest";
import { compareVersions, decide, parseIndexVersion } from "./index-version-guard.mjs";

describe("a PR that bumps INDEX_VERSION", () => {
  it("fails when its value equals the base's", () => {
    const verdict = decide({ touched: true, base: "0.28.0", head: "0.28.0" });

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("0.29.0");
  });

  it("fails when its value is below the base's", () => {
    expect(decide({ touched: true, base: "0.29.0", head: "0.28.0" }).ok).toBe(false);
  });

  it("passes when its value is above the base's, comparing parts as numbers", () => {
    expect(decide({ touched: true, base: "0.28.0", head: "0.29.0" }).ok).toBe(true);
    expect(decide({ touched: true, base: "0.9.0", head: "0.10.0" }).ok).toBe(true);
  });
});

it("passes a PR that never touches INDEX_VERSION even when the values are equal", () => {
  expect(decide({ touched: false, base: "0.28.0", head: "0.28.0" }).ok).toBe(true);
});

it("fails when either side's source has no parsable INDEX_VERSION", () => {
  const head = parseIndexVersion("export const INDEX_VERSION = getVersion();\n");

  expect(head).toBeNull();
  expect(decide({ touched: false, base: "0.28.0", head }).ok).toBe(false);
});

it("reads the version from the exported constant line", () => {
  const source = '// INDEX_VERSION history\nexport const INDEX_VERSION = "0.28.0";\n';

  expect(parseIndexVersion(source)).toBe("0.28.0");
});

it("orders versions by major, then minor, then patch", () => {
  expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  expect(compareVersions("0.28.1", "0.28.0")).toBeGreaterThan(0);
  expect(compareVersions("0.28.0", "0.28.0")).toBe(0);
});
