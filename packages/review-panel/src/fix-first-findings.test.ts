import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import type { ReviewerMessage } from "./ports.js";
import { ciUnreadOnly } from "./ci-unread.js";
import { CI_UNREAD_LINE, FINDINGS_SEPARATOR, FIX_FIRST_TRUNCATED, MAX_FIX_FIRST_TEXT_CHARS, boundedFindings, contradictedPicks, fixFirstFindings } from "./fix-first-findings.js";

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

/** The seat reviewer's probe table (TP-3050 round 2), with its block given a 40-hex head so a well-formed message can fit the template. */
describe("ciUnreadOnly against the reviewer's probe", () => {
  const L = CI_UNREAD_LINE;
  const SEP = FINDINGS_SEPARATOR;
  const blk = `Verdict: FIX_FIRST\nPR: o/r#1\nHead: ${HEAD}`;
  const m = (body: string) => `${body}\n\n${blk}`;
  const D = "Defect class: CI unread";
  const crlf = (text: string) => text.replace(/(?<!\r)\n/g, "\r\n");

  it.each<[string, string, boolean]>([
    ["exact line only", m(L), true],
    ["list item only", m(`- ${L}`), true],
    ["line + defect class naming more than CI unread", m(`- ${L}\n\nDefect class: none, CI unread`), false],
    ["repeat across two messages", m(L) + SEP + m(`- ${L}`), true],
    ["real BLOCKING list item beside", m(`- ${L}\n- Blocking: foo.ts:12 drops errors`), false],
    ["real Blocking: line beside", m(`${L}\nBlocking: race in bar.ts`), false],
    ["2nd msg real item below 1st msg defect class", m(`${L}\nDefect class: x`) + SEP + m(`- real bug in baz.ts`), false],
    ["item below defect class same msg", m(`${L}\nDefect class: x\n- real bug in baz.ts`), false],
    ["truncated", boundedFindings("x".repeat(20000) + m(L)), false],
    ["Earlier findings not fixed (before defect)", m(`Earlier findings:\n- not fixed: null deref\n${L}`), false],
    ["Earlier findings not fixed AFTER defect class", m(`- ${L}\n\nDefect class: none\n\nEarlier findings:\n- not fixed: null deref at a.ts:3`), false],
    ["Follow-ups list not in the item shape", m(`- ${L}\n\nFollow-ups:\n- [low] rename x`), false],
    ["lowercase", m(`- blocking: ci unread`), false],
    ["double space", m(`- Blocking:  CI unread`), false],
    ["trailing period", m(`- Blocking: CI unread.`), false],
    ["backticked", m("- `Blocking: CI unread`"), false],
    ["bold", m("- **Blocking: CI unread**"), false],
    ["tab after dash", m(`-\t${L}`), true],
    ["trailing ws", m(`${L}   `), true],
    ["empty FIX_FIRST", m(""), false],
    ["empty string", "", false],
    ["prose paragraph beside", m(`${L}\n\nAlso: the retry loop in sync.ts never terminates when the API returns 500.`), false],
    ["markdown heading finding", m(`${L}\n\n### 1. Retry loop never terminates (sync.ts:40)`), false],
    ["bold numbered finding", m(`${L}\n\n**1.** Retry loop never terminates`), false],
    ["unicode bullet finding", m(`${L}\n• Retry loop never terminates`), false],
    ["BLOCKING heading then para", m(`## Blocking\n\nRetry loop never terminates in sync.ts\n\n${L}`), false],
    ["'1 -' finding", m(`${L}\n1 - Retry loop never terminates`), false],
    ["indented prose", m(`${L}\n    sync.ts:40 loops forever`), false],
    ["table row finding", m(`${L}\n| 1 | sync.ts:40 | loops forever |`), false],
    ["Follow-ups no blank line then real finding", m(`- ${L}\n\nFollow-ups:\n- Cache it | cached | low\n- Blocking: retry loop never terminates\n\n${D}`), false],
    ["Follow-ups at end, real finding after, no blank", m(`- ${L}\n\n${D}\n\nFollow-ups:\n- Cache it | cached | low\nThe retry loop never terminates in sync.ts`), false],
    ["Follow-ups free-text line (not item shape)", m(`- ${L}\n\nFollow-ups:\nsync.ts:40 also loops forever, must fix before merge\n\n${D}`), false],
    ["Defect class w/ trailing prose", m(`- ${L}\n\nDefect class: CI unread. Also sync.ts:40 retry never terminates.`), false],
    ["Defect class naming a real defect", m(`- ${L}\n\nDefect class: unbounded retry in sync.ts`), false],
    ["- fixed: no. the loop still hangs", m(`- ${L}\n\nEarlier findings:\n- fixed: no. the loop still hangs\n\n${D}`), false],
    ["- fixed: partially, null deref remains", m(`- ${L}\n\nEarlier findings:\n- fixed: partially; the null deref at a.ts:3 remains\n\n${D}`), false],
    ["- fixed: outside Earlier findings", m(`- ${L}\n- fixed: but sync.ts:40 still loops\n\n${D}`), false],
    ["Not Fixed caps", m(`- ${L}\n\nEarlier findings:\n- NOT FIXED: null deref\n\n${D}`), false],
    ["unfixed wording", m(`- ${L}\n\nEarlier findings:\n- still broken: null deref\n\n${D}`), false],
    ["Closer: lookalike with finding", m(`- ${L}\nCloser: no, the retry loop in sync.ts never terminates\n\n${D}`), false],
    ["PR: lookalike with finding", m(`- ${L}\nPR: also breaks the release script\n\n${D}`), false],
    ["Head: lookalike with finding", m(`- ${L}\nHead: the head drops errors at a.ts:3\n\n${D}`), false],
    ["indented Verdict: lookalike", m(`- ${L}\n   Verdict: the retry is wrong\n\n${D}`), false],
    ["CI-policy lookalike with finding", m(`- ${L}\nCI-policy: none; sync.ts:40 loops forever\n\n${D}`), false],
    ["closer: lowercase lookalike", m(`- ${L}\ncloser: the retry loop hangs\n\n${D}`), false],
    ["CRLF legit", m(`- ${L}\r\n\r\n${D}\r\n`).replace(/\n/g, "\r\n").replace(/\r\r/g, "\r"), true],
    ["CRLF with real item", crlf(`- ${L}\r\n- The retry never stops\r\n\r\n${D}\r\n\r\n${blk}`), false],
    ["CRLF Follow-ups no blank then real", crlf(`- ${L}\r\n\r\nFollow-ups:\r\n- Cache | cached | low\r\nThe retry never stops\r\n\r\n${D}\r\n\r\n${blk}`), false],
    ["lone CR separators", `- ${L}\r- The retry never stops\r\r${D}\r\r${blk}`, false],
    ["Earlier findings heading then prose", m(`- ${L}\n\nEarlier findings:\nthe null deref is still there\n\n${D}`), false],
    ["msg2 only real finding", m(`- ${L}\n\n${D}`) + SEP + m(`- the retry never stops`), false],
    ["zero-width space in line", m(`- Blocking:\u200b CI unread`), false],
    ["nbsp in line", m(`- Blocking:\u00a0CI unread`), false],
    ["item-shaped finding with no Follow-ups heading", m(`- ${L}\n- Blocking: sync.ts:40 retry never terminates | bound the loop | high`), false],
    ["item-shaped finding after a blank line, no heading", m(`${L}\n\n- a.ts:3 null deref crashes on empty input | guard it | high`), false],
    ["not fixed: in the item shape", m(`- ${L}\n- not fixed: null deref at a.ts:3 | still crashes | high`), false],
    ["fixed: in the item shape", m(`- ${L}\n- fixed: partially, a.ts:3 remains | x | low`), false],
    ["item-shaped finding before the Follow-ups heading", m(`- ${L}\n- leak in auth.ts | fix | high\n\nFollow-ups:\n- x | y | low`), false],
    ["item-shaped finding after Follow-ups: none", m(`- ${L}\n\nFollow-ups: none\n- a.ts:3 leaks token | fix | high`), false],
    ["lone CR inside a follow-up title", m(`- ${L}\n\nFollow-ups:\n- x\rBlocking: a.ts:3 leaks | y | low`), false],
    ["U+2028 inside a follow-up title", m(`- ${L}\n\nFollow-ups:\n- x\u2028Blocking: a.ts:3 leaks | y | low`), false],
    ["one legitimate follow-up under its heading", m(`${L}\n\nFollow-ups:\n- rename x | x is renamed | low`), true],
  ])("%s", (_, text, want) => {
    expect(ciUnreadOnly(text)).toBe(want);
  });
});

describe("ciUnreadOnly", () => {
  const defectClass = "Defect class: CI unread.";
  const unread = `- ${CI_UNREAD_LINE}`;
  const verdictOn = (findings: string) => `${findings}\n\n${block("FIX_FIRST")}`;

  it.each([
    ["the exact line", CI_UNREAD_LINE],
    ["the line as a list item", `1. ${CI_UNREAD_LINE}`],
    ["the line and a one-line defect class", `${unread}\n\n${defectClass}`],
    ["a tab after the dash", `-\t${CI_UNREAD_LINE}`],
    ["trailing whitespace", `${unread}   \n\n${defectClass}  `],
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
    ["a fixed earlier item, which may carry prose", `${unread}\n\nEarlier findings:\n- fixed: the retry never stops`],
    ["a defect class naming more than CI unread", `${unread}\n\nDefect class: CI unread at the reviewed head.`],
    ["a CI-policy line with an unknown key", `${unread}\nCI-policy: weakened everything`],
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
