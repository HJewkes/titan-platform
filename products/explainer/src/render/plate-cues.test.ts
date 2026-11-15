import { describe, expect, it } from "vitest";
import { StoryboardSchema } from "../storyboard.js";
import { compileTimeline } from "./compile-timeline.js";
import { checkPlateLog, PLATE_TOLERANCE_S, plateCues } from "./plate-cues.js";

const board = StoryboardSchema.parse({
  video_type: "sample-type",
  title: "A synthetic board",
  beats: [
    { id: "beat-01", type: "hook", duration_s: 4, spoken: "Builds fail on a cold cache.", slots: {}, cues: ["fail", "cold"] },
    { id: "beat-02", type: "outro", duration_s: 3, spoken: "That is the fix.", slots: {}, cues: ["fix."] },
    { id: "beat-03", type: "outro", duration_s: 3, spoken: "Nothing to cue.", slots: {} },
  ],
});

const word = (text: string, start: number) => ({ word: text, start });
const words = {
  beats: [
    { id: "beat-01", durationS: 4.5, words: [word("Builds", 0.1), word("fail", 0.4), word("cold", 1.2)] },
    { id: "beat-02", durationS: 3.1, words: [word("That", 0.1), word("fix.", 0.9)] },
    { id: "beat-03", durationS: 2, words: [word("Nothing", 0.1)] },
  ],
};

const timeline = () => compileTimeline(board, words, { slotsFor: () => ({}) });

describe("plateCues", () => {
  it("puts each cue at the beat start plus the word start, as compileTimeline resolves it", () => {
    const compiled = timeline();

    const cues = plateCues(compiled);

    expect(cues.schema).toBe("explainer.plate-cues/v1");
    expect(cues.beats[1]).toEqual({ id: "beat-02", startS: 4.5, durationS: 3.1, cues: { "fix.": 4.5 + 0.9 } });
    expect(cues.beats[0]?.cues.cold).toBeCloseTo(1.2, 9);
    for (const [i, beat] of compiled.beats.entries()) {
      for (const [cue, local] of Object.entries(beat.cues ?? {})) expect(cues.beats[i]?.cues[cue]).toBeCloseTo(beat.startS + local, 9);
    }
  });

  it("lists a beat without cues with an empty cue map", () => {
    expect(plateCues(timeline()).beats[2]?.cues).toEqual({});
  });
});

describe("checkPlateLog", () => {
  const cues = () => plateCues(timeline());

  it("passes a log within one frame of its cues", () => {
    const log = [{ beat: "beat-01", cue: "fail", atS: 0.4 + PLATE_TOLERANCE_S }];

    expect(checkPlateLog(cues(), log, PLATE_TOLERANCE_S)).toEqual([]);
  });

  it("names the beat and cue of an entry more than one frame off", () => {
    const log = [{ beat: "beat-01", cue: "cold", atS: 1.2 + 0.1 }];

    const problems = checkPlateLog(cues(), log, PLATE_TOLERANCE_S);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("beat-01");
    expect(problems[0]).toContain("cold");
  });

  it("names an unknown cue and an unknown beat", () => {
    const log = [{ beat: "beat-01", cue: "warm", atS: 1 }, { beat: "beat-09", cue: "fail", atS: 1 }];

    const problems = checkPlateLog(cues(), log, PLATE_TOLERANCE_S);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("warm");
    expect(problems[1]).toContain("beat-09");
  });
});
