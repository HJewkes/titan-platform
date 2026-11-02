import { describe, expect, it } from "vitest";
import type { ShadowLogRow } from "./log.js";
import { seedFactSteps } from "../../registry/steps/seed-facts.js";
import { factFamiliesOf, shadowGate, shadowReport } from "./report.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * HOUR).toISOString();
const FACTS = new Set(["tree", "diff", "landed"] as const);
const WINDOW = { since: NOW - 48 * HOUR, now: NOW };
const OPTIONS = { windowMs: 48 * HOUR, now: NOW, factFamilies: FACTS };

let nextId = 1;
function row(over: Partial<ShadowLogRow>): ShadowLogRow {
  return { id: nextId++, at: at(1), kind: "compare", family: "tree", runId: "run-a", memoKey: null, item: null, step: null, fact: null, class: "hit", cause: null, materialValid: true, fullValid: true, drift: [], markerId: null, detail: {}, ...over };
}

const entryEnd = (hoursAgo: number): ShadowLogRow => row({ kind: "entry-end", family: null, class: null, at: at(hoursAgo) });

function cleanLog(): ShadowLogRow[] {
  return [
    entryEnd(50),
    row({ family: "tree", class: "hit" }),
    row({ family: "tree", class: "miss" }),
    row({ family: "diff", class: "hit" }),
    row({ family: "diff", class: "pin-differs", cause: "rebase-context", memoKey: "carry:abc" }),
  ];
}

const gate = (rows: ShadowLogRow[]) => shadowGate(shadowReport(rows, WINDOW), OPTIONS);

describe("shadow report and gate", () => {
  it("48 h of hit and miss rows with classified pin-differs rows passes", () => {
    const result = gate(cleanLog());

    expect(result).toMatchObject({ pass: true, reasons: [], families: { tree: "pass", diff: "pass", observed: "vacuous" } });
    expect(shadowReport(cleanLog(), WINDOW).counts.diff).toMatchObject({ causes: { "rebase-context": 1 }, classes: { hit: 1, "pin-differs": 1 } });
  });

  it("one unclassified pin-differs row blocks, naming its run and head", () => {
    const bad = row({ family: "diff", class: "pin-differs", cause: "unclassified", runId: "run-bad", detail: { carry: { head: "deadbeef" } } });

    const result = gate([...cleanLog(), bad]);

    expect(result.pass).toBe(false);
    expect(result.families.diff).toBe("blocked");
    expect(result.reasons.join("\n")).toMatch(/run run-bad, head deadbeef/);
  });

  it.each([
    ["false-hit", { class: "false-hit" }],
    ["unmarked", { class: "unmarked" }],
    ["shadow-error", { kind: "shadow-error", class: null }],
    ["budget-exceeded", { kind: "budget-exceeded", class: null }],
  ] as const)("a %s row in a gated family blocks", (_name, over) => {
    const result = gate([...cleanLog(), row({ family: "tree", ...over })]);

    expect(result.pass).toBe(false);
    expect(result.families.tree).toBe("blocked");
  });

  it("a shadow first on 30 h ago blocks on coverage", () => {
    const result = gate([entryEnd(30), ...cleanLog().slice(1)]);

    expect(result.pass).toBe(false);
    expect(result.reasons).toEqual([expect.stringMatching(/coverage/)]);
  });

  it("the observed family with no fact entry is vacuous and does not block; the tree family with no rows blocks", () => {
    const observedOnly = gate([entryEnd(50), row({ family: "observed", class: "unmarked" }), row({ family: "diff", class: "hit" })]);

    expect(observedOnly.families).toMatchObject({ observed: "vacuous", tree: "blocked" });
    expect(observedOnly.reasons).toEqual(["tree: no compared rows"]);
  });

  it("rows outside the window are not counted", () => {
    const report = shadowReport([...cleanLog(), row({ family: "tree", class: "false-hit", at: at(60) })], WINDOW);

    expect(report.blocking).toEqual([]);
    expect(report.counts.tree.classes).toEqual({ hit: 1, miss: 1 });
  });

  it("the seeded fact entries cover the tree and diff families but not observed", () => {
    expect([...factFamiliesOf(seedFactSteps)].sort()).toEqual(["diff", "landed", "tree"]);
  });
});
