import { fakeSha } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import type { ReviewerMessage } from "./review.js";
import { FINDINGS_SEPARATOR, FIX_FIRST_TRUNCATED, MAX_FIX_FIRST_TEXT_CHARS, fixFirstFindings } from "./fix-first-findings.js";

const HEAD = fakeSha("findings-head");
const OLD_HEAD = fakeSha("findings-old-head");
const target = { repo: "octo/demo", pr: 7, head: HEAD };
const block = (verdict: string, head = HEAD) => `Verdict: ${verdict}\nPR: octo/demo#7\nHead: ${head}`;
const said = (text: string, writtenAt: number): ReviewerMessage => ({ agentId: "a", sessionId: "s", writtenAt, text, locator: {} as SourceTextLocator });

describe("fixFirstFindings", () => {
  it("joins every FIX_FIRST at the head that says more than its block, oldest first, each once", () => {
    const first = `1. Off by one.\n\n${block("FIX_FIRST")}`;
    const fuller = `1. Off by one.\n2. Missing test.\n\n${block("FIX_FIRST")}`;

    const findings = fixFirstFindings(target, [said(fuller, 3), said(first, 1), said(first, 2), said(block("FIX_FIRST"), 4)], "fallback");

    expect(findings).toBe(`${first}${FINDINGS_SEPARATOR}${fuller}`);
  });

  it("leaves out a FIX_FIRST for an older head and a MERGE at this head", () => {
    const findings = fixFirstFindings(target, [said(`1. Stale.\n\n${block("FIX_FIRST", OLD_HEAD)}`, 1), said(`Fine.\n\n${block("MERGE")}`, 2)], block("FIX_FIRST"));

    expect(findings).toBe(block("FIX_FIRST"));
  });

  it("cuts from the start so the newest findings survive, heading kept, within the cap", () => {
    const old = `${"o".repeat(MAX_FIX_FIRST_TEXT_CHARS)}\n\n${block("FIX_FIRST")}`;
    const newest = `2. The newest finding.\n\n${block("FIX_FIRST")}`;

    const findings = fixFirstFindings(target, [said(old, 1), said(newest, 2)], "fallback", "Heading.\n\n");

    expect(findings).toHaveLength(MAX_FIX_FIRST_TEXT_CHARS);
    expect(findings.startsWith(`Heading.\n\n${FIX_FIRST_TRUNCATED}`)).toBe(true);
    expect(findings.endsWith(newest)).toBe(true);
  });
});
