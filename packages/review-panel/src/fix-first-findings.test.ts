import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import type { ReviewerMessage } from "./ports.js";
import { ciUnreadOnly } from "./ci-unread.js";
import { CI_UNREAD_LINE, FINDINGS_SEPARATOR, FIX_FIRST_TRUNCATED, MAX_FIX_FIRST_TEXT_CHARS, contradictedPicks, fixFirstFindings } from "./fix-first-findings.js";

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
  const unread = `- ${CI_UNREAD_LINE}`;
  const verdictOn = (findings: string) => `${findings}\n\n${block("FIX_FIRST")}`;

  it.each([
    ["the exact line", CI_UNREAD_LINE],
    ["the line as a list item", `1. ${CI_UNREAD_LINE}`],
    ["the line and a one-line defect class", `${unread}\n\n${defectClass}`],
    ["a tab after the dash", `-\t${CI_UNREAD_LINE}`],
    ["trailing whitespace", `${unread}   \n\n${defectClass}  `],
    ["no earlier finding left", `${unread}\n\nEarlier findings:\n- fixed: the retry never stops\n\n${defectClass}`],
    ["earlier findings none found", `${unread}\n\nEarlier findings: none found\n\n${defectClass}`],
    ["a follow-ups section, which never blocks", `${unread}\n\nFollow-ups:\n- Cache the read | the read is cached | low\n\n${defectClass}`],
  ])("a FIX_FIRST of only the CI-unread line (%s) reads as CI-unread-only", (_, findings) => {
    expect(ciUnreadOnly(verdictOn(findings))).toBe(true);
  });

  it("the CI-unread line repeated across two joined messages reads as CI-unread-only", () => {
    const message = verdictOn(unread);

    expect(ciUnreadOnly(`${message}${FINDINGS_SEPARATOR}${message}`)).toBe(true);
  });

  it.each([
    ["a real list item", `${unread}\n- The retry never stops.`],
    ["a numbered real item", `1. ${CI_UNREAD_LINE}\n2. The retry never stops.`],
    ["another bare Blocking line", `${CI_UNREAD_LINE}\nBlocking: the retry never stops.`],
    ["a prose paragraph", `${unread}\n\nAlso: the retry loop in sync.ts never terminates when the server answers 503.`],
    ["a heading item", `${unread}\n### 1. Retry loop never terminates`],
    ["a bold-numbered item", `${unread}\n**1.** Retry loop never terminates`],
    ["a unicode bullet", `${unread}\n\u2022 Retry loop never terminates`],
    ["a number-dash item", `${unread}\n1 - Retry loop never terminates`],
    ["a Blocking heading over prose", `## Blocking\n${unread}\nThe retry loop never terminates.`],
    ["an indented line", `${unread}\n    the retry loop never terminates`],
    ["a table row", `${unread}\n| 1 | sync.ts:40 | loops forever |`],
    ["a list item below the defect class", `${unread}\n\n${defectClass}\n- real bug`],
    ["defect-class prose over more than one line", `${unread}\n\n${defectClass}\nThe boundary is the retry helper.`],
    ["a not-fixed earlier item after the defect class", `${unread}\n\n${defectClass}\n\nEarlier findings:\n- not fixed: null deref at a.ts:3`],
    ["a lookalike line with more words", `${CI_UNREAD_LINE} at head`],
    ["a lowercase lookalike", CI_UNREAD_LINE.toLowerCase()],
    ["a CI finding of the reviewer's own", "- CI is unverified at this head"],
  ])("the CI-unread line beside %s does not", (_, findings) => {
    expect(ciUnreadOnly(verdictOn(`${findings}\n\n${defectClass}`))).toBe(false);
  });

  it("a real item in a later joined message does not", () => {
    expect(ciUnreadOnly(`${verdictOn(`${unread}\n\n${defectClass}`)}${FINDINGS_SEPARATOR}${verdictOn("- The retry never stops.")}`)).toBe(false);
  });

  it("a joined message that does not name the line does not", () => {
    expect(ciUnreadOnly(`${verdictOn(unread)}${FINDINGS_SEPARATOR}${verdictOn(defectClass)}`)).toBe(false);
  });

  it("findings cut to the cap do not, since the cut may have dropped a real item", () => {
    expect(ciUnreadOnly(`${FIX_FIRST_TRUNCATED}${verdictOn(unread)}`)).toBe(false);
  });

  it("a FIX_FIRST with no blocking item does not", () => {
    expect(ciUnreadOnly(block("FIX_FIRST"))).toBe(false);
  });
});
