import { describe, expect, it } from "vitest";
import { guardBeat, type BeatRewrite } from "./rewrite-guard.js";
import { ScriptSchema, type ScriptBeat } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const ORIGINAL =
  "The desk server checks each scan. It retries 3 times. Then it writes 12 rows to the ledger. The ledger keeps them.";

function beatWith(overrides: Record<string, unknown> = {}, spoken = ORIGINAL): ScriptBeat {
  const script = ScriptSchema.parse(scriptWith({ spoken, ...overrides }));
  const [beat] = script.beats;
  if (!beat) throw new Error("fixture has no beat");
  return beat;
}

const withCues = (cues: string[], spoken = ORIGINAL) =>
  beatWith({ visual: { assertion: "One server sits between every scanner and the ledger", job: "map", cues: cues.map((atCue) => ({ action: "V6", target: "n1", atCue })) } }, spoken);

const joined: BeatRewrite = {
  spoken: "The desk server checks each scan and retries 3 times, then it writes the rows to the ledger, which keeps them.",
  labelsAdded: ["12 rows written"],
};

const rules = (before: ScriptBeat, after: BeatRewrite, opts = {}) => guardBeat(before, after, opts).map((r) => r.rule);

describe("guardBeat", () => {
  it("accepts a joined rewrite that moves a number into a label", () => {
    expect(guardBeat(beatWith(), joined)).toEqual([]);
  });

  it("rejects a removed number that no appended label carries", () => {
    expect(rules(beatWith(), { ...joined, labelsAdded: [] })).toContain("number-lost");
  });

  it("rejects a label that only paraphrases the removed number", () => {
    expect(rules(beatWith(), { ...joined, labelsAdded: ["a dozen rows"] })).toContain("number-lost");
  });

  it("rejects a number the original never spoke", () => {
    const after = { ...joined, spoken: joined.spoken.replace("retries 3 times", "retries 7 times") };
    expect(rules(beatWith(), after)).toContain("number-invented");
  });

  it("rejects a rewrite that drops a cue word", () => {
    const before = withCues(["ledger"]);
    const after = { ...joined, spoken: joined.spoken.replace(/ledger/g, "store") };
    expect(rules(before, after)).toContain("cue-lost");
  });

  it("rejects cues that land in a different order", () => {
    const before = withCues(["server", "ledger"]);
    const after = { ...joined, spoken: "The ledger keeps rows that the desk server checks on each scan, retries 3 times and writes." };
    expect(rules(before, after)).toContain("cue-order");
  });

  it("accepts cues that keep their order", () => {
    expect(guardBeat(withCues(["server", "ledger"]), joined)).toEqual([]);
  });

  it("rejects a rewrite that stops speaking a new term", () => {
    const before = beatWith({ new_terms: ["ledger"] });
    const after = { ...joined, spoken: joined.spoken.replace(/ledger/g, "store") };
    expect(rules(before, after)).toContain("new-term");
  });

  const longSentence =
    "The desk server checks each scan and retries 3 times before it writes the rows to the ledger, which keeps them so that every courier sees the same state afterwards.";

  it("rejects a sentence over the cap when no speech verdict is given", () => {
    const after = { spoken: longSentence, labelsAdded: ["12 rows written"] };
    expect(rules(beatWith(), after)).toContain("sentence-cap");
  });

  it("accepts that sentence when the speech verdict calls it clean", () => {
    const after = { spoken: longSentence, labelsAdded: ["12 rows written"] };
    expect(rules(beatWith(), after, { speechClean: () => true })).not.toContain("sentence-cap");
  });

  it("honours an injected vetted ceiling", () => {
    const after = { spoken: longSentence, labelsAdded: ["12 rows written"] };
    expect(rules(beatWith(), after, { speechClean: () => true, maxVettedSentenceWords: 26 })).toContain("sentence-cap");
  });

  it("rejects altered markup", () => {
    const before = beatWith({}, "The [ledger](=led-jer) keeps every scan. It retries 3 times. It stays small.");
    const after = { spoken: "The ledger keeps every scan and retries 3 times. It stays small.", labelsAdded: [] };
    expect(rules(before, after)).toContain("markup");
  });

  it("rejects an empty rewrite", () => {
    expect(rules(beatWith(), { spoken: "  ", labelsAdded: [] })).toContain("empty");
  });
});
