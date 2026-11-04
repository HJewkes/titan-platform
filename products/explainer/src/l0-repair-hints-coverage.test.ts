import { describe, expect, it } from "vitest";
import { withClaimFacts } from "./claim-facts.js";
import { L0_CHECKS, runL0, type L0Result } from "./eval-l0.js";
import { HINTED_CHECKS, repairHint } from "./l0-repair-hints.js";
import { withCoverage } from "./lint-coverage.js";
import { whyCheck } from "./lint-why.js";
import { shippedRuleRegistry } from "./rules.js";
import { parseSpine } from "./spine-schema.js";
import { GOOD_BEATS, tour, withBeat } from "./voice-flow-fixtures.test-helpers.js";
import { SPINE } from "./workflow/run-fakes.test-helpers.js";

const STAKE = { who: "The courier", loses_what: "A parcel printed against a missing row", number: "3 refused labels", fact_ids: ["F-1"] };
const FACTS = [{ id: "task/QA-901/opened", kind: "task" }];
const COVERAGE = { merged: 1, lanes: [{ id: "qa", label: "QA", rollup: "lane/qa/rollup", merged: 1, named: [] }], prs: [{ pr: "pr/acme/widgets#1/merged", lane: "qa", thread: "QA-901", named: false }] };

/** Every error-severity row the script stage's L0 emits, with the spine, the gathered facts and the coverage manifest it reads. */
function scriptStageErrorIds(): string[] {
  const rows = runL0(tour(), undefined, withCoverage(withClaimFacts(L0_CHECKS, FACTS), COVERAGE, FACTS), undefined, parseSpine(SPINE));
  return [...new Set(rows.filter((row) => row.severity === "error").map((row) => row.check_id))];
}

const failingOn = (check_id: string, beats: string[]): L0Result => ({ check_id, mode: "tagged", severity: "error", value: beats.length + 1, threshold: 0, pass: false, detail_beats: beats });

describe("repair hint coverage", () => {
  // Mutation: dropping any one table from HINTS leaves its rule ids unhinted here.
  it("gives every error-severity L0 rule the script stage can fail a repair hint of its own", () => {
    const ids = scriptStageErrorIds();

    const unhinted = ids.filter((id) => !HINTED_CHECKS.has(id));

    expect(ids.length).toBeGreaterThan(30);
    expect(unhinted).toEqual([]);
  });

  // Mutation: returning the table hint as it is leaves hints that re-read the script silent on the row's beats.
  it("gives every error-severity check in the rules registry a hint that names the beats its row fails", () => {
    const ids = shippedRuleRegistry().rules.flatMap(({ l0 }) => (l0?.status === "implemented" && l0.severity === "error" ? l0.checks : []));
    const script = tour();

    const silent = ids.filter((id) => !repairHint(failingOn(id, ["h2", "w2"]), script, FACTS, parseSpine(SPINE))?.match(/\b(h2|w2)\b/));

    expect(ids.length).toBeGreaterThan(40);
    expect(silent).toEqual([]);
  });

  it("answers a failing row of every hinted rule without throwing", () => {
    const script = tour();

    const hints = [...HINTED_CHECKS].map((id) => [id, () => repairHint(failingOn(id, ["h2", "w2"]), script, FACTS, parseSpine(SPINE), COVERAGE)] as const);

    hints.forEach(([id, hint]) => expect(hint, id).not.toThrow());
  });
});

describe("the Q-W1 hint", () => {
  // Mutation: naming the late carriers, or dropping the stake's number, leaves the edit short of what Q-W1 reads.
  it("names the early STAKE beat and the two things it must say, and that edit passes the check", () => {
    const script = tour(GOOD_BEATS, { stake: STAKE });
    const row = runL0(script, undefined, [whyCheck]).find((r) => r.check_id === "Q-W1")!;

    const hint = repairHint(row, script);
    const edited = tour(withBeat("h2", { spoken: "You lose 3 refused labels a day when the desk prints before it checks the ledger." }), { stake: STAKE });

    expect(row.pass).toBe(false);
    expect(hint).toContain('h2 (STAKE, at 9 %), and none says "you" (or "The courier") together with a number');
    expect(hint).toContain('In h2, say "you" and the stake\'s number "3 refused labels" in one sentence');
    expect(runL0(edited, undefined, [whyCheck]).find((r) => r.check_id === "Q-W1")?.pass).toBe(true);
  });

  it("says when no stake beat starts early enough", () => {
    const late = GOOD_BEATS.map((spec): typeof spec => (spec[0] === "h2" ? [spec[0], spec[1], "WHAT", spec[3], spec[4]] : spec));
    const script = tour(late, { stake: STAKE });
    const row = runL0(script, undefined, [whyCheck]).find((r) => r.check_id === "Q-W1")!;

    expect(repairHint(row, script)).toMatch(/^no STAKE beat starts before 15 % of planned time/);
  });
});
