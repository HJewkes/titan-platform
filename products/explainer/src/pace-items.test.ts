import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cueKindRole, fromScriptV1, type PaceBeat } from "./pace-items.js";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { fromSpikeScript } from "./spike-script.js";
import { v4Durations, v4Script } from "./spike-fixtures.test-helpers.js";
import { readTiming } from "./timing.js";

const v4 = (): PaceBeat[] => fromSpikeScript(v4Script(), readTiming(v4Durations())).beats;
const beat = (beats: PaceBeat[], id: string): PaceBeat => {
  const found = beats.find((b) => b.id === id);
  if (!found) throw new Error(`no beat ${id}`);
  return found;
};
const labels = (items: { label: string }[]) => items.map((i) => i.label);
const byRole = (b: PaceBeat, role: string) => labels(b.items.filter((i) => i.role === role));

const JOBS = ["choose", "make", "prove", "land", "keep going", "ask the owner", "be legible"];

describe("the v4 item track", () => {
  // Mutation: dropping the earlier-beat check from newness makes r3-3's Backlog and Broker new again.
  it("counts r2-1's seven jobs and r2-2's seven invariants as new, and r1-3's boxes as old by r3-3", () => {
    const beats = v4();

    expect(labels(beat(beats, "r2-1-jobs").newItems)).toEqual(JOBS);
    const invariants = labels(beat(beats, "r2-2-inv").newItems);
    expect(invariants).toHaveLength(7);
    expect(invariants.filter((l) => JOBS.includes(l))).toEqual([]);
    expect(labels(beat(beats, "r3-3-plans").newItems)).toEqual(["Plans"]);
  });

  // Mutation: dropping the same-beat pin exemption makes r3-3 count 4 items and its pin a new item.
  it("treats a pin on a box revealed in the same beat as an attribute, and a pin on an earlier box as an item", () => {
    const beats = v4();

    expect(byRole(beat(beats, "r3-3-plans"), "item")).toEqual(["Backlog", "Broker", "Plans"]);
    expect(byRole(beat(beats, "r3-3-plans"), "attribute")).toEqual(["contract per slice"]);
    expect(byRole(beat(beats, "r4-1-plan"), "item")).toEqual(["risk class", "exclusive paths", "plan sitting"]);
  });

  // Mutation: classing left/right as items makes r10-2 count 7 items.
  it("treats compare cells as attributes and compare side titles as items", () => {
    const q1 = beat(v4(), "r10-2-q1");

    expect(byRole(q1, "item")).toEqual(["(a) fast-forward", "(b) API merges"]);
    expect(byRole(q1, "attribute")).toHaveLength(5);
  });

  // Mutation: dropping the HookBeat count-card skip adds "7 nouns" and r1-1's two count cards.
  it("does not count a HookBeat's count card as an item", () => {
    const beats = v4();

    expect(beat(beats, "r1-1-hook").items).toEqual([]);
    expect(labels(beat(beats, "r3-1-nouns").items)).not.toContain("7 nouns");
    expect(beat(beats, "r3-1-nouns").items).toHaveLength(7);
  });

  // Mutation: classing recipe verbs as items gives r3b-3 a new "replay" item.
  it("counts recipe verbs as actions and recipe notes as items", () => {
    const beats = v4();

    expect(beat(beats, "r3b-3-replay").items.map((i) => [i.kind, i.role])).toEqual([["replay", "action"]]);
    expect(labels(beat(beats, "r3b-1-run").newItems)).toEqual(["a five-step recipe", "51.5 steps per run"]);
  });

  // Mutation: reading `timed` as "timing was passed" marks the dropped beat timed with a heard length.
  it("marks a beat with no heard duration timed:false and falls back to its planned length", () => {
    const durations = z.object({ beats: z.array(z.looseObject({ id: z.string() })) }).parse(v4Durations());
    const timing = readTiming({ beats: durations.beats.filter((b) => b.id !== "r2-1-jobs") });

    const { beats } = fromSpikeScript(v4Script(), timing);

    expect(beat(beats, "r2-1-jobs")).toMatchObject({ timed: false, durationS: 7 });
    expect(beat(beats, "r2-2-inv")).toMatchObject({ timed: true, durationS: 14.2 });
    expect(fromSpikeScript(v4Script()).beats.every((b) => !b.timed)).toBe(true);
  });
});

describe("the kind table", () => {
  // Mutation: defaulting an unknown kind to "item" lets a new renderer's cues go uncounted as errors.
  it("throws on an unknown cue kind and names it", () => {
    const Cue = z.looseObject({ target: z.string() });
    const script = z
      .looseObject({ beats: z.array(z.looseObject({ visual: z.looseObject({ cues: z.array(Cue).default([]) }) })) })
      .parse(v4Script());
    const [firstCue] = script.beats[0]?.visual.cues ?? [];
    if (!firstCue) throw new Error("r1-1-hook has no cue");
    firstCue.target = "widget:4 stores";

    expect(() => fromSpikeScript(script)).toThrow(/unknown cue kind "widget"/);
    expect(cueKindRole("detail")).toBe("attribute");
  });
});

const v1Script = () =>
  ScriptSchema.parse(
    scriptWith({
      new_terms: ["desk server"],
      visual: {
        assertion: "One server sits between every scanner and the ledger",
        job: "map",
        cues: [{ action: "V11", target: "row:Ledger", atCue: "ledger" }],
        map_state: {
          level: "containers",
          reveal: [{ id: "desk-server", atCue: "server" }],
          pins: [{ anchor: "desk-server", text: "one per site", atCue: "desk" }],
        },
      },
    }),
  );

describe("the item track of a script/v1", () => {
  // Mutation: dropping new_terms from the V1 adapter loses "desk server".
  it("takes items from off-map cues, reveals, pins and new terms", () => {
    const [b] = fromScriptV1(v1Script());

    expect(b?.items.map((i) => [i.source, i.label, i.role])).toEqual([
      ["cue", "Ledger", "item"],
      ["reveal", "desk-server", "item"],
      ["pin", "one per site", "attribute"],
      ["term", "desk server", "item"],
    ]);
    expect(b).toMatchObject({ mapBeside: true, timed: false, durationS: 14 });
  });

  // Mutation: ignoring the heard word starts leaves every atS null.
  it("times each cued item from the heard word starts", () => {
    const timing = readTiming({
      beats: [{ id: "c2-1-stations", durationS: 5.5, words: [{ word: "desk", start: 1.1 }, { word: "server", start: 1.4 }, { word: "ledger.", start: 3.2 }] }],
    });

    const [b] = fromScriptV1(v1Script(), timing);

    expect(b?.items.map((i) => i.atS)).toEqual([3.2, 1.4, 1.1, null]);
    expect(b).toMatchObject({ timed: true, durationS: 5.5 });
  });

  // Mutation: comparing labels without case-folding and trimming makes "ledger " new in the second beat.
  it("does not count a label shown in an earlier beat as new, whatever its case", () => {
    const script = v1Script();
    const second = { ...script.beats[0]!, id: "c2-2-again", new_terms: ["ledger "], visual: { ...script.beats[0]!.visual, cues: [], map_state: undefined } };

    const [, b] = fromScriptV1({ ...script, beats: [script.beats[0]!, second] });

    expect(b?.items).toHaveLength(1);
    expect(b?.newItems).toEqual([]);
  });
});
