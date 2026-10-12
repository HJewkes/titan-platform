import { describe, expect, it } from "vitest";
import { changesetVersions, compareVersions, decide, parseIndexVersion } from "./index-version-guard.mjs";

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

describe("a changeset the PR adds", () => {
  it("declares a version with each phrasing main's changesets use", () => {
    const texts = [
      "Classify fixtures. `INDEX_VERSION` is now 0.28.0, so the first index reparses.",
      "INDEX_VERSION moves to 0.24.0.",
      "`INDEX_VERSION` goes to 0.25.0 and INDEX_VERSION bumps to 0.26.0.",
      "Bumps `INDEX_VERSION` to 0.29.0 (TP-2474 l).",
    ];

    expect(changesetVersions(texts)).toEqual(["0.28.0", "0.24.0", "0.25.0", "0.26.0", "0.29.0"]);
  });

  it("declares nothing when it says the version stays or is unchanged", () => {
    const texts = [
      "`INDEX_VERSION` stays at 0.28.0.",
      "No `INDEX_VERSION` change (still 0.28.0).",
      "`INDEX_VERSION` is unchanged.",
    ];

    expect(changesetVersions(texts)).toEqual([]);
  });

  it("counts as touching INDEX_VERSION when no commit changed the line", () => {
    expect(decide({ touched: false, base: "0.28.0", head: "0.28.0", declared: ["0.28.0"] }).ok).toBe(false);
    expect(decide({ touched: false, base: "0.28.0", head: "0.29.0", declared: ["0.29.0"] }).ok).toBe(true);
  });

  it("fails when its declared version differs from the PR's value", () => {
    const verdict = decide({ touched: true, base: "0.28.0", head: "0.30.0", declared: ["0.29.0"] });

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("declares INDEX_VERSION 0.29.0 but the PR's value is 0.30.0");
  });
});
