import { describe, expect, it } from "vitest";
import { findingRoutes, invariantsStated, seatRoutes, unseated } from "./lint-seat.js";
import { buildPaceBeats, type PaceSourceBeat } from "./pace-items.js";
import { fromSpikeScript } from "./spike-script.js";
import { v4Script } from "./spike-fixtures.test-helpers.js";

interface Spec {
  spoken?: string;
  cues?: string[];
  mapBeside?: boolean;
  render?: string;
}

const source = (id: string, { spoken = "A plain sentence.", cues = [], mapBeside = false, render }: Spec): PaceSourceBeat => ({
  id,
  chapter: "ch1",
  fn: "WHAT",
  spoken,
  plannedS: 10,
  mapBeside,
  ...(render === undefined ? {} : { render }),
  cues: cues.map((target) => ({ target })),
  titles: [],
  reveals: [],
  pins: [],
  cards: [],
  terms: [],
});

const beatsOf = (specs: Record<string, Spec>) => buildPaceBeats(Object.entries(specs).map(([id, spec]) => source(id, spec)));

const INVARIANTS = ["State survives restarts.", "Pool caps hold."];

describe("M5a: an invariant is stated only on a map, one at a time", () => {
  // Mutation: counting only `inv:` cues lets a spoken invariant with no map pass.
  it("fails a beat that speaks an invariant phrase with no inv cue and no map", () => {
    const beats = beatsOf({ b1: { spoken: "And state survives restarts." } });

    expect(unseated(beats, INVARIANTS)).toEqual(["b1"]);
  });

  // Mutation: `> 1` relaxed to `> 2`, or no count check, passes the two-invariant map beat.
  it("passes one invariant phrase on a map beat and fails two", () => {
    const beats = beatsOf({
      one: { spoken: "State survives restarts.", mapBeside: true },
      two: { spoken: "State survives restarts, and pool caps hold.", mapBeside: true },
    });

    expect(unseated(beats, INVARIANTS)).toEqual(["two"]);
  });

  // Mutation: dropping the word-boundary padding matches "restarts" inside "restartsafe".
  it("matches a phrase only on word boundaries", () => {
    const beats = beatsOf({ b1: { spoken: "The state survives restartsafe mode." } });

    expect(invariantsStated(beats[0]!, ["state survives restarts"])).toBe(0);
    expect(unseated(beats, ["state survives restarts"])).toEqual([]);
  });

  // Mutation: summing cues and phrases counts one invariant twice and fails the map beat.
  it("counts an inv label and its spoken phrase as one invariant", () => {
    const beats = beatsOf({ b1: { spoken: "State survives restarts.", cues: ["inv:I7 survives restart"], mapBeside: true } });

    expect(invariantsStated(beats[0]!, INVARIANTS)).toBe(1);
    expect(unseated(beats, INVARIANTS)).toEqual([]);
  });

  // Mutation: reading only the spoken text misses an inv cue on a beat that never says the phrase.
  it("fails an inv cue with no map even when no phrase is spoken", () => {
    const beats = beatsOf({ b1: { cues: ["inv:I4 pool caps"] } });

    expect(unseated(beats, [])).toEqual(["b1"]);
  });
});

describe("M5b: a finding with no map beside it is routed, not errored", () => {
  // Mutation: checking only the beat's own map routes a StatBeat that sits next to a map beat.
  it("routes a StatBeat only when neither it nor a neighbour has a map", () => {
    const beats = beatsOf({
      map: { mapBeside: true },
      near: { render: "StatBeat", cues: ["stat:143 claimed"] },
      gap: {},
      far: { render: "StatBeat", cues: ["stat:20 patches"] },
      after: {},
    });

    expect(findingRoutes(beats)).toEqual(["far"]);
  });

  // Mutation: routing on render alone routes a StatBeat that shows no stat.
  it("does not route a StatBeat with no stat item, nor a stat on another render", () => {
    const beats = beatsOf({ empty: { render: "StatBeat", cues: ["note:a caption"] }, list: { render: "ListBeat", cues: ["stat:3 runs"] } });

    expect(findingRoutes(beats)).toEqual([]);
  });
});

describe("the seat lint on the v4 subset", () => {
  const v4 = () => fromSpikeScript(v4Script());

  // Mutation: checking only the beat's own map also routes r1-2 and r1-6, StatBeats beside the r1-3 and r1-5 maps.
  it("fails r2-2-inv for M5a and routes only r2-4-measure for M5b", () => {
    const { beats, invariants } = v4();

    expect(unseated(beats, invariants)).toEqual(["r2-2-inv"]);
    expect(findingRoutes(beats)).toEqual(["r2-4-measure"]);
  });

  // Mutation: dropping phrase detection still fails r2-2 on its 7 cues; with the cues stripped it states 0, not 3.
  it("finds three spoken invariant phrases on r2-2-inv", () => {
    const { beats, invariants } = v4();
    const r22 = beats.find((b) => b.id === "r2-2-inv")!;

    expect(invariantsStated({ ...r22, items: [] }, invariants)).toBe(3);
  });

  // Mutation: losing either reason, or listing routes out of script order, changes the E5 route list.
  it("hands the L1 seat judge each routed beat with its reason, in script order", () => {
    const { beats, invariants } = v4();

    expect(seatRoutes(beats, invariants)).toEqual([
      { beat: "r2-2-inv", reason: "invariant" },
      { beat: "r2-4-measure", reason: "finding" },
    ]);
  });
});
