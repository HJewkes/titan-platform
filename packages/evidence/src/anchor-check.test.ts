import { describe, expect, it } from "vitest";
import { isAnchorForm } from "./anchor.js";
import { verifyAnchorText } from "./anchor-check.js";
import { lineSourceFromTexts } from "./line-source.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const pins = { repo: "example/repo", head: HEAD, base: BASE };
const numbered = (count: number, tag: string): string => Array.from({ length: count }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";
const files = { [HEAD]: lineSourceFromTexts({ "a.ts": numbered(15, "head") }), [BASE]: lineSourceFromTexts({ "a.ts": numbered(30, "base") }) };
const source = (rev: string) => files[rev] ?? lineSourceFromTexts({});

describe("verifyAnchorText", () => {
  it("refuses a range that starts inside the file but ends past EOF, naming the line count", () => {
    expect(verifyAnchorText("head/a.ts#L10-L20", pins, source)).toEqual({
      ok: false,
      reason: "past-eof",
      detail: "head/a.ts#L10-L20: past EOF (15 lines)",
    });
  });

  it("quotes the first and last anchored lines back", () => {
    expect(verifyAnchorText("head/a.ts#L10-L15", pins, source)).toMatchObject({ ok: true, first: "head 10", last: "head 15" });
  });

  it("checks a base anchor against the base commit", () => {
    expect(verifyAnchorText("base/a.ts#L20-L30", pins, source)).toMatchObject({ ok: true, first: "base 20", last: "base 30" });
  });

  it("checks each side of a cross-side diff anchor at its own commit", () => {
    expect(verifyAnchorText("diff/a.ts#L25-R12", pins, source)).toMatchObject({ ok: true, first: "base 25", last: "head 12" });
    expect(verifyAnchorText("diff/a.ts#L12-R25", pins, source)).toMatchObject({ ok: false, reason: "past-eof" });
  });

  it("refuses a path that is not a file at the pinned commit", () => {
    expect(verifyAnchorText("head/b.ts#L1", pins, source)).toEqual({ ok: false, reason: "path-unreadable", detail: `head/b.ts#L1: not a file at ${HEAD}` });
  });

  it("refuses an anchor the grammar refuses before reading any file", () => {
    expect(verifyAnchorText("head/a.ts#L9-L3", pins, source)).toMatchObject({ ok: false, reason: "bad-anchor" });
  });
});

describe("isAnchorForm", () => {
  it("tells an anchor from free text", () => {
    expect(isAnchorForm("head/src/a.ts#L3")).toBe(true);
    expect(isAnchorForm("see the PR thread")).toBe(false);
    expect(isAnchorForm("https://example.com/head/x#L1")).toBe(false);
  });
});
