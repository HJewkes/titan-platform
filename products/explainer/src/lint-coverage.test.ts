import { describe, expect, it } from "vitest";
import { runL0 } from "./eval-l0.js";
import { repairHint } from "./l0-repair-hints.js";
import { coverageCheck, coverageCheckWith, reflectionCheck, reflectionCheckWith, withCoverage, type CoverageManifest } from "./lint-coverage.js";
import { goodScript } from "./lint-fixtures.test-helpers.js";
import { ScriptSchema, type ScriptV1 } from "./script-schema.js";

// An invented day on an invented repo, acme/widgets: three lanes, one counted, one named, one left out.
const pr = (n: number) => `pr/acme/widgets#${n}/merged`;
const MANIFEST: CoverageManifest = {
  merged: 6,
  lanes: [
    { id: "alpha", label: "Alpha", rollup: "lane/alpha/rollup", merged: 3, named: ["WID-1"] },
    { id: "beta", label: "Beta", rollup: "lane/beta/rollup", merged: 2, named: ["WID-2"] },
    { id: "gamma", label: "Gamma", rollup: "lane/gamma/rollup", merged: 1, named: ["WID-3"] },
  ],
  prs: [
    { pr: pr(11), lane: "alpha", thread: "WID-1", named: true },
    { pr: pr(12), lane: "alpha", thread: "WID-4", named: false },
    { pr: pr(13), lane: "alpha", thread: "WID-5", named: false },
    { pr: pr(21), lane: "beta", thread: "WID-2", named: true },
    { pr: pr(22), lane: "beta", thread: "WID-2", named: true },
    { pr: pr(31), lane: "gamma", thread: "WID-3", named: true },
  ],
};

type BeatSpec = [id: string, chapter: string, spoken: string, facts: string[], labels?: string[]];

function daily(specs: readonly BeatSpec[]): ScriptV1 {
  const base = goodScript();
  const chapters = [...new Set(specs.map(([, chapter]) => chapter))].map((id) => ({ id, label: id, question: `What about ${id}?` }));
  const beats = specs.map(([id, chapter, spoken, fact_ids, labels = []]) => ({ ...base.beats[4]!, id, chapter, spoken, fact_ids, visual: { ...base.beats[4]!.visual, labels } }));
  return ScriptSchema.parse({ ...base, profile: "daily-overview", chapters, beats });
}

const ALPHA_COUNTED: BeatSpec = ["l1", "lanes", "Alpha shipped widget sizing and three merges in all.", [pr(11), "lane/alpha/rollup"]];
const BETA_NAMED: BeatSpec = ["l2", "lanes", "Beta finished the widget cache in two pull requests.", [pr(21), pr(22)]];
const GAMMA_NAMED: BeatSpec = ["s1", "ships", "Gamma's import fix is the ship that mattered.", [pr(31)]];

const q21 = (script: ScriptV1, manifest?: CoverageManifest) => runL0(script, undefined, [coverageCheckWith(manifest)]).find((r) => r.check_id === "Q-E21")!;

describe("Q-E21: every merged PR is named or counted under its lane", () => {
  it("passes when one lane is counted by its rollup and total, one named, and one named from the ships chapter", () => {
    const script = daily([ALPHA_COUNTED, BETA_NAMED, GAMMA_NAMED]);

    const row = q21(script, MANIFEST);

    expect(row).toMatchObject({ pass: true, severity: "error", value: 0 });
  });

  // Mutation: dropping the check that the total is said lets a bare rollup citation count a lane.
  it("fails a lane whose rollup is cited but whose total is neither said nor shown", () => {
    const silent: BeatSpec = ["l1", "lanes", "Alpha shipped widget sizing and more.", [pr(11), "lane/alpha/rollup"]];
    const shown: BeatSpec = [silent[0], silent[1], silent[2], silent[3], ["3 merged"]];

    expect(q21(daily([silent, BETA_NAMED, GAMMA_NAMED]), MANIFEST)).toMatchObject({ pass: false, value: 1 });
    expect(q21(daily([shown, BETA_NAMED, GAMMA_NAMED]), MANIFEST)).toMatchObject({ pass: true });
  });

  it("does not count a lane whose rollup is cited outside the lanes chapter", () => {
    const elsewhere: BeatSpec = ["b1", "bottom-line", "Alpha merged three today.", [pr(11), "lane/alpha/rollup"]];

    expect(q21(daily([elsewhere, BETA_NAMED, GAMMA_NAMED]), MANIFEST)).toMatchObject({ pass: false });
  });

  it("fails a lane left out, and a named PR its lane's count does not excuse", () => {
    const partBeta: BeatSpec = ["l2", "lanes", "Beta merged two.", [pr(21), "lane/beta/rollup"]];

    const row = q21(daily([ALPHA_COUNTED, partBeta]), MANIFEST);

    expect(row).toMatchObject({ pass: false, value: 3 });
  });

  it("reports a passing warning that says it did not run when no manifest reaches it", () => {
    expect(q21(daily([ALPHA_COUNTED]))).toMatchObject({ pass: true, severity: "warning" });
  });
});

describe("the Q-E21 repair hint", () => {
  // Mutation: a lane left out yields no line naming its rollup fact and total.
  it("names the left-out lane's rollup fact and total, and the named PR no beat cites", () => {
    const script = daily([ALPHA_COUNTED, BETA_NAMED]);
    const row = q21(script, MANIFEST);

    const hint = repairHint(row, script, undefined, undefined, MANIFEST);

    expect(hint).toContain("lane gamma: 1 of its 1 merged PRs are uncited, so cite lane/gamma/rollup in a lanes beat and say 1 in it");
    expect(hint).toContain(`lane gamma names ${pr(31)}: cite it`);
    expect(hint).not.toContain("lane alpha");
  });
});

const SLOW = [{ id: "slow/owner-touches" }, { id: "next/WID-9" }];
const q22 = (script: ScriptV1, facts?: { id: string }[]) => runL0(script, undefined, [reflectionCheckWith(facts)]).find((r) => r.check_id === "Q-E22")!;

describe("Q-E22: each reflection proposal cites the slowdown it answers", () => {
  const proposal: BeatSpec = ["r1", "reflection", "Batch the owner's taps into one morning queue.", ["slow/owner-touches"]];
  const priority: BeatSpec = ["r2", "reflection", "First tomorrow: the widget export.", ["next/WID-9"]];

  it("passes when each reflection beat cites a slowdown or a priority fact", () => {
    expect(q22(daily([ALPHA_COUNTED, proposal, priority]), SLOW)).toMatchObject({ pass: true, severity: "error" });
  });

  // Mutation: accepting any cited fact lets a proposal cite a merged PR as its evidence.
  it("fails a proposal that cites no slowdown fact, and its hint names the beat and the slowdowns to cite", () => {
    const bare: BeatSpec = ["r3", "reflection", "Review faster.", [pr(11)]];
    const script = daily([ALPHA_COUNTED, proposal, bare]);

    const row = q22(script, SLOW);

    expect(row).toMatchObject({ pass: false, value: 1, detail_beats: ["r3"] });
    expect(repairHint(row, script, SLOW)).toContain("reflection beats citing no slowdown or priority fact: r3. Cite in each proposal the slow/ fact it answers (slow/owner-touches)");
  });

  it("does not run without slowdown facts or without a reflection chapter", () => {
    const bare: BeatSpec = ["r3", "reflection", "Review faster.", []];

    expect(q22(daily([ALPHA_COUNTED, bare]), [{ id: pr(11) }])).toMatchObject({ pass: true, severity: "warning" });
    expect(q22(daily([ALPHA_COUNTED]), SLOW)).toMatchObject({ pass: true, severity: "warning" });
  });
});

describe("withCoverage", () => {
  it("swaps the registered no-input checks for ones that read the manifest and facts, and keeps the rest", () => {
    const other = () => [];

    const [coverage, reflection, kept] = withCoverage([coverageCheck, reflectionCheck, other], MANIFEST, SLOW);

    const script = daily([GAMMA_NAMED, ["r3", "reflection", "Review faster.", []]]);
    expect(coverage!({ script, view: [] })[0]).toMatchObject({ severity: "error", pass: false });
    expect(reflection!({ script, view: [] })[0]).toMatchObject({ severity: "error", pass: false });
    expect(kept).toBe(other);
  });
});
