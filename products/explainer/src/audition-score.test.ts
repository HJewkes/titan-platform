import { describe, expect, it } from "vitest";
import type { SpineCandidate } from "./audition-sample.js";
import { codeScores, coverageScore, fitScore, freshnessScore, pickCandidate, rangeScore, tensionChecks, type ScoreContext } from "./audition-score.js";
import { loadDoctrine } from "./doctrine-load.js";
import type { MaterialFact } from "./material-facts.js";
import { buildMaterialMap } from "./material-map.js";
import { loadProfiles, profileFor, structureFor } from "./profile-load.js";

const set = loadProfiles();
const vocabulary = loadDoctrine().vocabulary.signals;
const profile = profileFor(set, "repo-argument");

/** Synthetic facts: F1 a pain (a stake), F2 a mechanism, F3 a neutral detail; F1 and F2 are P1. */
const FACTS: MaterialFact[] = [
  { id: "F1", text: "Builds are slow on every laptop.", priority: "p1" },
  { id: "F2", text: "The cache keys each step by its inputs.", priority: "p1" },
  { id: "F3", text: "The cache lives in one directory.", priority: "p2" },
];

const mapOf = (facts: readonly MaterialFact[]) =>
  buildMaterialMap({ factsSha: "0".repeat(64), format: "facts-md", facts, profile, structures: set.structures, vocabulary });

const ctx = (series: ScoreContext["series"] = []): ScoreContext => ({ map: mapOf(FACTS), profile, facts: FACTS, series });

/** An abt spine for repo-argument: stake up front, payoff in the third block at 25 %. */
function spine(over: Partial<SpineCandidate> = {}): SpineCandidate {
  return {
    structure: "abt", system: null, likelihood: 0.4, sentence: "Builds are slow, but the cache keys steps, so reruns are free.",
    hook: { fact: "F1", line: "Every laptop waits on the same build." },
    blocks: [
      { id: "situation", question: "Why wait?", facts: ["F1"], seconds: 30, beat: "hook", covers: ["pain-or-anomaly"] },
      { id: "complication", question: "What fails?", facts: ["F1", "F3"], seconds: 30, beat: "stakes", covers: [] },
      { id: "resolution", question: "How does the cache help?", facts: ["F2"], seconds: 120, beat: "code-walk", covers: ["one-claim", "mechanism-shown"] },
      { id: "takeaway", question: "What to keep?", facts: ["F2"], seconds: 60, beat: "takeaways", covers: ["takeaway"] },
    ],
    payoff: "resolution", signatureLayer: "a cache ledger that fills as steps rerun", cuts: [],
    ...over,
  };
}

describe("audition code scores", () => {
  it("fit is the share of predicate terms met: abt fits on a central problem, kishotenketsu counts its gap half", () => {
    const map = mapOf(FACTS);

    expect(fitScore(structureFor(set.structures, "abt"), map)).toBe(1);
    expect(fitScore(structureFor(set.structures, "kishotenketsu"), map)).toBe(0.25);
    expect(fitScore(structureFor(set.structures, "kishotenketsu"), mapOf([{ id: "F1", text: "The cache lives in one directory." }]))).toBe(0.75);
  });

  it("coverage averages P1 facts placed and coverage items covered", () => {
    expect(coverageScore(spine(), ctx())).toBe(1);
    const thin = spine({ blocks: spine().blocks.map((b) => ({ ...b, facts: ["F1"], covers: [] })) });

    expect(coverageScore(thin, ctx())).toBe(0.25);
  });

  it("tension checks the stake, the complication, the re-hook band and where the payoff lands", () => {
    expect(tensionChecks(spine(), ctx())).toEqual({ "stake by 15%": true, "complication by 25%": true, "re-hook within 90 s": false, "payoff set up by 40%": true });
    const early = spine({ blocks: spine().blocks.map((b) => ({ ...b, seconds: 60 })) });

    expect(tensionChecks(early, ctx())).toMatchObject({ "complication by 25%": true, "re-hook within 90 s": true, "payoff set up by 40%": false });
    expect(tensionChecks({ ...early, payoff: "complication" }, ctx())["payoff set up by 40%"]).toBe(true);
  });

  it("a stake that lands after 25% fails the complication check", () => {
    const late = spine({ hook: { fact: "F3", line: "One directory." }, blocks: spine().blocks.map((b, i) => ({ ...b, facts: i === 3 ? ["F1"] : ["F3"] })) });

    expect(tensionChecks(late, ctx())).toMatchObject({ "stake by 15%": false, "complication by 25%": false });
  });

  it("range is distinct lead beats over blocks", () => {
    expect(rangeScore(spine())).toBe(1);
    expect(rangeScore(spine({ blocks: spine().blocks.map((b) => ({ ...b, beat: "code-walk" })) }))).toBe(0.25);
  });

  it("freshness is 1 with no series, and drops for each must-vary field the series window repeats", () => {
    expect(freshnessScore(spine(), ctx())).toBe(1);
    expect(freshnessScore(spine(), ctx([{ structure: "abt", signatureLayer: "a dial" }]))).toBe(0.5);
    expect(freshnessScore(spine(), ctx([{ structure: "abt", signatureLayer: "A cache ledger that fills as steps rerun " }]))).toBe(0);
  });

  it("freshness reads only the series window", () => {
    const old = { structure: "abt", signatureLayer: "a cache ledger that fills as steps rerun" };
    const other = { structure: "scqa", signatureLayer: "a dial" };

    expect(freshnessScore(spine(), ctx([old, ...Array.from({ length: profile.variety.window }, () => other)]))).toBe(1);
  });

  it("the total is the mean of the five criteria", () => {
    const { scores } = codeScores(spine(), structureFor(set.structures, "abt"), ctx());

    expect(scores).toEqual({ fit: 1, coverage: 1, tension: 0.75, range: 1, freshness: 1, total: 0.95 });
  });
});

describe("audition pick", () => {
  it("picks the highest total and names the runner-up with the margin", () => {
    const result = pickCandidate([{ id: "c1", total: 0.7, likelihood: 0.5 }, { id: "c2", total: 0.82, likelihood: 0.2 }, { id: "c3", total: 0.75, likelihood: 0.3 }]);

    expect(result).toEqual({ pick: { id: "c2", total: 0.82, likelihood: 0.2 }, runnerUp: { id: "c3", total: 0.75, likelihood: 0.3 }, margin: 0.07 });
  });

  it("a tie goes to the higher stated likelihood, then the earlier slot", () => {
    expect(pickCandidate([{ id: "c1", total: 0.8, likelihood: 0.2 }, { id: "c2", total: 0.8, likelihood: 0.5 }]).pick.id).toBe("c2");
    expect(pickCandidate([{ id: "c1", total: 0.8, likelihood: 0.3 }, { id: "c2", total: 0.8, likelihood: 0.3 }])).toMatchObject({ pick: { id: "c1" }, runnerUp: { id: "c2" }, margin: 0 });
  });

  it("refuses to pick from fewer than two scored candidates", () => {
    expect(() => pickCandidate([{ id: "c1", total: 1, likelihood: 1 }])).toThrow(/at least 2/);
  });
});
