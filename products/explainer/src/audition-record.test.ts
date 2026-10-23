import { describe, expect, it } from "vitest";
import { chapterBlocks, rubricCandidate, skippedRows, withoutSkipped } from "./audition-record.js";
import type { SpineCandidate } from "./audition-sample.js";
import type { ColdRubricResult } from "./eval-cold-rubric.js";
import { loadProfiles, profileFor } from "./profile-load.js";

const profile = profileFor(loadProfiles(), "repo-argument");

/** A synthetic abt storyboard; the last block id is one no profile names. */
const SPINE: SpineCandidate = {
  structure: "abt", system: null, likelihood: 0.4, sentence: "Builds are slow, but the cache keys steps, so reruns are free.",
  hook: { fact: "F1", line: "Every laptop waits on the same build." },
  blocks: ["situation", "complication", "resolution", "coda"].map((id) => ({ id, question: `What about ${id}?`, facts: ["F1"], seconds: 60, beat: "code-walk", covers: [] })),
  payoff: "resolution", signatureLayer: "a cache ledger that fills as steps rerun", cuts: [],
};

const verdict = (score: number | null) => ({ score, evidence: "", void_reason: score === null ? "quote shorter than 2 words" : null });
const RUBRIC = {
  dims: (["J8", "J9", "J10", "J11", "J12"] as const).map((dim) => ({ dim, verdict: verdict(dim === "J12" ? null : 3) })),
} as ColdRubricResult;

describe("audition record", () => {
  it("shows the cold viewer only the signature layer as a visual, never a bare beat id", () => {
    const beats = rubricCandidate("c1", SPINE).beats;

    expect(beats.map((b) => b.screen)).toEqual([[SPINE.signatureLayer], [], [], [], []]);
  });

  it("skips J12 with a reason when a storyboard has fewer than two quotable visuals", () => {
    expect(skippedRows(rubricCandidate("c1", SPINE))).toEqual([{ dim: "J12", reason: "the storyboard shows a quotable visual on 1 beat; visual consistency needs 2 to compare" }]);
    expect(skippedRows(rubricCandidate("c1", { ...SPINE, signatureLayer: "ledger" }))[0]!.reason).toMatch(/on 0 beats;/);
  });

  it("judges J12 once two beats carry a quotable visual", () => {
    const candidate = rubricCandidate("c1", SPINE);
    const shown = { ...candidate, beats: candidate.beats.map((b, i) => (i === 1 ? { ...b, screen: ["the ledger again"] } : b)) };

    expect(skippedRows(shown)).toEqual([]);
  });

  it("a skipped row leaves the rubric instead of standing as a void score", () => {
    const skipped = skippedRows(rubricCandidate("c1", SPINE));

    expect(withoutSkipped(RUBRIC, skipped)!.dims.map((d) => d.dim)).toEqual(["J8", "J9", "J10", "J11"]);
    expect(withoutSkipped(RUBRIC, [])).toEqual(RUBRIC);
    expect(withoutSkipped(null, skipped)).toBeNull();
  });

  it("maps each script chapter to the profile block it plays, in spine order", () => {
    expect(chapterBlocks(SPINE, profile)).toEqual([
      { chapter: "ch1", block: "situation" },
      { chapter: "ch2", block: "complication" },
      { chapter: "ch3", block: "resolution" },
      { chapter: "ch4", block: null },
    ]);
  });
});
