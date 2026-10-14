import { describe, expect, it } from "vitest";
import { isFullSha, parseAnchor } from "./anchor.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const pins = { repo: "example/repo", head: HEAD, base: BASE };

describe("accepted anchors", () => {
  it("resolves a head range to the head pin", () => {
    expect(parseAnchor("head/src/a.ts#L10-L20", pins)).toEqual({
      ok: true,
      anchor: { side: "head", repo: "example/repo", rev: HEAD, path: "src/a.ts", lineStart: 10, lineEnd: 20 },
    });
  });

  it("resolves a single base line to the base pin", () => {
    expect(parseAnchor("base/src/a.ts#L7", pins)).toMatchObject({ ok: true, anchor: { side: "base", rev: BASE, lineStart: 7, lineEnd: 7 } });
  });

  it("resolves each diff endpoint to the side its prefix names", () => {
    expect(parseAnchor("diff/src/a.ts#L84-R90", pins)).toMatchObject({
      ok: true,
      anchor: { side: "diff", path: "src/a.ts", start: { side: "L", line: 84, rev: BASE }, end: { side: "R", line: 90, rev: HEAD } },
    });
  });

  it("accepts a head anchor with no base pin", () => {
    expect(parseAnchor("head/a.ts#L1", { repo: "example/repo", head: HEAD }).ok).toBe(true);
  });
});

describe("refused anchors", () => {
  it.each([
    ["head/a.ts#L20-L10", "bad-range"],
    ["diff/a.ts#R9-R3", "bad-range"],
    ["head/a.ts#L0", "bad-range"],
    ["head//etc/passwd#L1", "bad-path"],
    ["head/C:/x.ts#L1", "bad-path"],
    ["head/src/../secret.ts#L1", "bad-path"],
    ["head/src\\a.ts#L1", "bad-path"],
    ["head/   #L1", "bad-path"],
    ["head/a\tb.ts#L1", "bad-path"],
    ["head/a.ts#R1", "bad-syntax"],
    ["diff/a.ts#84-90", "bad-syntax"],
    ["tip/a.ts#L1", "bad-syntax"],
    ["head/a.ts", "bad-syntax"],
  ])("refuses %s as %s", (text, reason) => {
    expect(parseAnchor(text, pins)).toMatchObject({ ok: false, reason });
  });

  it("refuses base/ and diff/ anchors when no base is pinned", () => {
    const headOnly = { repo: "example/repo", head: HEAD };
    expect(parseAnchor("base/a.ts#L7", headOnly)).toMatchObject({ ok: false, reason: "bad-pin" });
    expect(parseAnchor("diff/a.ts#L1-R2", headOnly)).toMatchObject({ ok: false, reason: "bad-pin" });
  });

  it("refuses a head pin that is a ref name rather than a commit id", () => {
    expect(parseAnchor("head/a.ts#L1", { repo: "example/repo", head: "main" })).toMatchObject({ ok: false, reason: "bad-pin" });
  });
});

describe("isFullSha", () => {
  it("accepts only a full lowercase 40-hex id", () => {
    expect(isFullSha(HEAD)).toBe(true);
    expect(isFullSha("HEAD")).toBe(false);
    expect(isFullSha(HEAD.slice(1))).toBe(false);
    expect(isFullSha(HEAD.toUpperCase())).toBe(false);
  });
});
