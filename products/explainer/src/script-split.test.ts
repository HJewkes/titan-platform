import { describe, expect, it } from "vitest";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { BEAT_SECONDS } from "./lint-flow.js";
import type { ScriptBeat } from "./script-schema.js";
import { splitCuelessBeats } from "./script-split.js";

// Three sentences of a synthetic parcel-floor reflection: together past the 8 s stretch, each one within it.
const THREE_SENTENCES =
  "You might blame the review queue, but no gate on the floor waited on the lead. The dock scanner is what slows us, at a median of eighteen minutes on the north line. The router lane should test its matcher on every dock, and the cache lane should warm its store.";
const RUN_ON =
  "What slows the floor down is the shared review queue, where every lane waits its turn, and the drafts that sit idle until another lane lands first, while small lanes ship faster than one big queue and today showed it again";

const longClaim = (spoken: string) => dailyWith("reflection-2", { plannedS: 20, heldS: 4, spoken });
const piecesOf = (beats: readonly ScriptBeat[]): ScriptBeat[] => beats.filter((beat) => beat.id.startsWith("reflection-2"));

describe("the $0 split of a cue-less claim-card", () => {
  it("a cue-less claim-card past the stretch limit splits on sentence boundaries with every word kept", () => {
    const script = longClaim(THREE_SENTENCES);

    const { script: split, splits } = splitCuelessBeats(script);

    const pieces = piecesOf(split.beats);
    expect(splits).toEqual([{ id: "reflection-2", pieces: ["reflection-2", "reflection-2b", "reflection-2c"] }]);
    expect(split.beats.map((beat) => beat.id)).toEqual(script.beats.flatMap((beat) => (beat.id === "reflection-2" ? splits[0]!.pieces : [beat.id])));
    expect(pieces.map((beat) => beat.visual.beat)).toEqual(["claim-card", "claim-card", "claim-card"]);
    expect(pieces.map((beat) => beat.spoken).join(" ")).toBe(THREE_SENTENCES);
    expect(l0Row(split, "Q-D17").detail_beats).toEqual([]);
  });

  it("each split piece keeps the beat floor and only the last keeps heldS", () => {
    const script = longClaim(THREE_SENTENCES);

    const pieces = piecesOf(splitCuelessBeats(script).script.beats);

    expect(pieces.map((beat) => beat.plannedS).every((s) => s >= BEAT_SECONDS[0])).toBe(true);
    expect(pieces.reduce((sum, beat) => sum + beat.plannedS, 0)).toBe(20);
    expect(pieces.map((beat) => beat.heldS)).toEqual([undefined, undefined, 4]);
  });

  it("a claim-card with no valid sentence split is left for the repair", () => {
    const script = longClaim(RUN_ON);

    const result = splitCuelessBeats(script);

    expect(l0Row(script, "Q-D17").detail_beats).toEqual(["reflection-2"]);
    expect(result).toEqual({ script, splits: [] });
  });
});
