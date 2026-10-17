import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import type { ReviewerMessage } from "./ports.js";
import { CI_UNREAD_LINE, FINDINGS_SEPARATOR, FIX_FIRST_TRUNCATED, MAX_FIX_FIRST_TEXT_CHARS, ciUnreadOnly, contradictedPicks, fixFirstFindings } from "./fix-first-findings.js";

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
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

describe("contradictedPicks", () => {
  const ids = ["edge-colour", "density"];

  it("returns each recorded pick a contradiction line names, once", () => {
    const text = `1. Edges are under 3:1.\nOwner pick contradicted: edge-colour\n  Owner pick contradicted: density\nOwner pick contradicted: edge-colour\n\n${block("FIX_FIRST")}`;

    expect(contradictedPicks(text, ids)).toEqual(["edge-colour", "density"]);
  });

  it("ignores ids that were not recorded and lookalike text", () => {
    const text = [
      "Owner pick contradicted: spacing",
      "Owner pick contradicted: edge-colour-2",
      "Owner pick contradicted: edge-colour because the contrast is low",
      "The owner pick contradicted: density here",
      "1. Owner pick contradicted: edge",
    ].join("\n");

    expect(contradictedPicks(text, ids)).toEqual([]);
  });

  it("finds nothing when no pick is recorded", () => {
    expect(contradictedPicks("Owner pick contradicted: edge-colour", [])).toEqual([]);
  });
});

describe("ciUnreadOnly", () => {
  const defectClass = "Defect class: CI unread at the reviewed head.";

  it.each([
    ["bare", `${CI_UNREAD_LINE}\n\n${defectClass}`],
    ["as a list item", `I could not read CI.\n\n- ${CI_UNREAD_LINE}\n\n${defectClass}\n- gh api was denied`],
    ["numbered, with no defect-class section", `1. ${CI_UNREAD_LINE}`],
  ])("a FIX_FIRST of only the CI-unread line (%s) reads as CI-unread-only", (_, findings) => {
    expect(ciUnreadOnly(`${findings}\n\n${block("FIX_FIRST")}`)).toBe(true);
  });

  it("the CI-unread line in two joined messages is still one item", () => {
    const message = `- ${CI_UNREAD_LINE}\n\n${block("FIX_FIRST")}`;

    expect(ciUnreadOnly(`${message}${FINDINGS_SEPARATOR}${message}`)).toBe(true);
  });

  it("a real item in a later joined message, below the first message's defect class, does not", () => {
    const first = `- ${CI_UNREAD_LINE}\n\n${defectClass}\n\n${block("FIX_FIRST")}`;
    const second = `- The retry never stops.\n\n${block("FIX_FIRST")}`;

    expect(ciUnreadOnly(`${first}${FINDINGS_SEPARATOR}${second}`)).toBe(false);
  });

  it("findings cut to the cap do not, since the cut may have dropped a real item", () => {
    expect(ciUnreadOnly(`${FIX_FIRST_TRUNCATED}- ${CI_UNREAD_LINE}\n\n${block("FIX_FIRST")}`)).toBe(false);
  });

  it("the CI-unread line beside a real item does not", () => {
    expect(ciUnreadOnly(`1. ${CI_UNREAD_LINE}\n2. The retry never stops.\n\n${defectClass}\n\n${block("FIX_FIRST")}`)).toBe(false);
  });

  it("the CI-unread line beside another bare Blocking line does not", () => {
    expect(ciUnreadOnly(`${CI_UNREAD_LINE}\nBlocking: the retry never stops.\n\n${block("FIX_FIRST")}`)).toBe(false);
  });

  it.each([`${CI_UNREAD_LINE} at head`, CI_UNREAD_LINE.toLowerCase(), `- CI is unverified at this head`])("a lookalike line (%s) does not", (line) => {
    expect(ciUnreadOnly(`${line}\n\n${defectClass}\n\n${block("FIX_FIRST")}`)).toBe(false);
  });

  it("a FIX_FIRST with no blocking item does not", () => {
    expect(ciUnreadOnly(block("FIX_FIRST"))).toBe(false);
  });
});
