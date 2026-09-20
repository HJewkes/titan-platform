import { describe, expect, it } from "vitest";
import { DEFAULT_SIGNAL_PATTERNS, EMPTY_OUTPUT_SIGNAL, createSignalParser, createSignalSetParser, parseSignal, parseSignals } from "./signals.js";

describe("an output carrying several signals", () => {
  const review = "## Verdict: PASS\nRisk Score: 5\n## Open Questions\nShould we widen scope?\n";

  it("reports every signal, highest precedence first", () => {
    expect(parseSignals(review)).toEqual(["high_risk", "has_open_questions", "approved"]);
  });

  it("surfaces high_risk as the single signal instead of the first prose match", () => {
    expect(parseSignal(review)).toBe("high_risk");
  });

  it("lets a risk score of 4 beat a PASS verdict", () => {
    expect(parseSignal("**PASS**\n\nRisk Level: 4")).toBe("high_risk");
  });

  it("ranks needs_revision over open questions", () => {
    expect(parseSignal("## Verdict: NEEDS REVISION\n\n## Open Questions\n- Something?\n")).toBe("needs_revision");
  });

  it("ranks needs_fixes below approval, as before", () => {
    expect(parseSignals("## Verdict: PASS\n\n## FIX Items\n1. nit")).toEqual(["approved", "needs_fixes"]);
  });
});

describe("empty output", () => {
  it.each([["an empty string", ""], ["whitespace", "  \n\t"], ["no output at all", undefined]])("parses %s as the escalation signal, never approval", (_label, output) => {
    expect(parseSignal(output)).toBe(EMPTY_OUTPUT_SIGNAL);
    expect(parseSignals(output)).toEqual([EMPTY_OUTPUT_SIGNAL]);
  });

  it("escalates under a custom pattern set too", () => {
    expect(createSignalParser({ done: (c) => /DONE/.test(c) })("")).toBe(EMPTY_OUTPUT_SIGNAL);
  });
});

describe("canonical marker", () => {
  it("overrides a conflicting prose verdict and hides the prose signals", () => {
    const output = "## Verdict: READY\nRisk Score: 5\n<!-- signal: needs_revision -->";
    expect(parseSignal(output)).toBe("needs_revision");
    expect(parseSignals(output)).toEqual(["needs_revision"]);
  });

  it("reports several known markers in precedence order", () => {
    expect(parseSignals("<!-- signal: approved -->\n<!-- signal: high_risk -->")).toEqual(["high_risk", "approved"]);
  });

  it("is case-insensitive and tolerates extra whitespace", () => {
    expect(parseSignal("<!-- SIGNAL: Needs_Revision -->")).toBe("needs_revision");
    expect(parseSignal("<!--   signal:    approved   -->")).toBe("approved");
  });

  it("falls back to prose when the marker names an unknown signal", () => {
    expect(parseSignal("<!-- signal: bogus_signal -->\n\n## Verdict: NEEDS REVISION")).toBe("needs_revision");
  });
});

describe("verdict prose", () => {
  it.each([
    ["## Verdict: NEEDS REVISION\n\nSome feedback.", "needs_revision"],
    ["verdict: **NEEDS REVISION**\n\nSee issues below.", "needs_revision"],
    ["The design has issues.\n\n**NEEDS REVISION**\n\nPlease fix.", "needs_revision"],
    ["## Open Questions\n- What about edge cases?\n", "has_open_questions"],
    ["Verdict: PASS\n\nAll good.", "approved"],
    ["## Verdict: READY\n\nDesign approved.", "approved"],
    ["verdict: **PASS**\n\nLooks good.", "approved"],
    ["Overall assessment:\n\n**PASS**", "approved"],
    ["Design review:\n\n**READY**\n\nShip it.", "approved"],
    ["Verdict: NEEDS WORK\n\n## FIX Items\n1. Fix X", "needs_fixes"],
    ["verdict: **NEEDS WORK**\n\nSeveral issues found.", "needs_fixes"],
    ["Review result:\n\n**NEEDS WORK**", "needs_fixes"],
    ["## FIX Items\n1. Something broken", "needs_fixes"],
    ["Status: changes requested", "changes_requested"],
    ["This needs clarification on the API.", "needs_clarification"],
    ["Risk Score: 5", "high_risk"],
    ["Risk Level: 4", "high_risk"],
    ["## Verdict: ITERATE\n\nNeeds polish.", "needs_changes"],
  ])("reads %j as %s", (output, signal) => {
    expect(parseSignal(output)).toBe(signal);
  });

  it.each([
    ["an unrecognized verdict", "## Verdict: APPROVED\n\nLooks good."],
    ["a low risk score", "Risk Score: 2"],
    ["an Open Questions section that says (none)", "## Open Questions\n(none)\n"],
    ["an Open Questions section that says None", "## Open Questions\nNone\n"],
    ["plain prose", "nothing here"],
  ])("finds no signal in %s", (_label, output) => {
    expect(parseSignal(output)).toBeNull();
    expect(parseSignals(output)).toEqual([]);
  });
});

describe("custom pattern sets", () => {
  const patterns = { blocked: (c: string) => /BLOCKED/.test(c), done: (c: string) => /DONE/.test(c) };

  it("replace the defaults and take their precedence from key order", () => {
    expect(createSignalSetParser(patterns)("DONE but BLOCKED")).toEqual(["blocked", "done"]);
    expect(createSignalParser(patterns)("## Verdict: PASS")).toBeNull();
  });

  it("honor a canonical marker for one of their own names", () => {
    expect(createSignalParser(patterns)("BLOCKED <!-- signal: done -->")).toBe("done");
  });

  it("rank an extra pattern where the caller inserted its key", () => {
    const parse = createSignalSetParser({ ...DEFAULT_SIGNAL_PATTERNS, blocked: (c: string) => /BLOCKED/.test(c) });
    expect(parse("## Verdict: PASS\nBLOCKED on infra")).toEqual(["approved", "blocked"]);
  });
});
