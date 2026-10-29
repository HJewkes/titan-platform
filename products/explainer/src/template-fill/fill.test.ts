import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../beat-slots.js";
import { ResolvedSchema } from "../resolve-stage.js";
import { shippedSpecs } from "../resolve-fixtures.test-helpers.js";
import { ScriptSchema } from "../script-schema.js";
import { DERIVERS } from "./derivers.js";
import { FillError, fillScript } from "./fill.js";
import { fill, filledBeat, fillFixture, fillSolo, fixtureScript, rawFixture, resolvedFor, soloScript } from "./fill-fixtures.test-helpers.js";

const cue = (target: string, atCue: string) => ({ action: "V6", target, atCue });
const ownerRow = { id: "rows-1", text: "Owner row", mark: "tick" };

function refusalOf(act: () => unknown): FillError {
  try {
    act();
  } catch (error) {
    if (error instanceof FillError) return error;
    throw error;
  }
  throw new Error("expected a FillError");
}

describe("template fill: slot layers", () => {
  it("lays resolver slots over the derived layer and the owner's visual.slots over both", () => {
    // Arrange
    const script = soloScript({ beat: "list", labels: ["tick Two lanes"], slots: { rows: [ownerRow] } });
    const beats = resolvedFor(script).beats.map((row) => ({ ...row, slots: { title: "Resolver title" } }));

    // Act
    const found = fillScript(script, { beats }, { specs: shippedSpecs }).beats[0]!;

    // Assert
    expect(found.slots).toEqual({ title: "Resolver title", rows: [ownerRow] });
    expect(found.generated).toEqual({ title: "Resolver title", rows: [{ id: "rows-1", text: "Two lanes", mark: "tick" }] });
    expect(found.overridden).toEqual(["rows"]);
  });

  it("takes a pinned slots entry in place of the derived layer", () => {
    // Arrange
    const pinned = { s1: { rows: [{ id: "rows-1", text: "Pinned row", mark: "dot" }] } };

    // Act
    const found = fillSolo({ beat: "list", labels: ["tick Two lanes"] }, undefined, { pinned });

    // Assert
    expect(found.slots).toEqual(pinned.s1);
    expect(found.fallback).toBeUndefined();
  });

  it("refuses a beat whose visual.slots leave its spec invalid rather than drawing a list", () => {
    // Arrange
    const script = soloScript({ beat: "list", labels: ["tick Two lanes"], slots: { rows: [] } });

    // Act
    const error = refusalOf(() => fill(script));

    // Assert
    expect(error.refusals).toEqual([{ beat: "s1", detail: expect.stringMatching(/visual\.slots leave list invalid: .*rows/) }]);
  });

  it("falls back from a spec that derives nothing, naming why, and draws it once visual.slots fill it", () => {
    // Arrange
    const tasks = [{ id: "tasks-1", label: "Lane rollout", start: "2031-02-01", end: "2031-02-14" }];

    // Act
    const [plain, filledByHand] = [filledBeat(fill(fixtureScript()), "b11"), fillSolo({ beat: "gantt", slots: { tasks } })];

    // Assert
    expect(plain.fallback).toEqual({ from: "gantt", reason: "gantt derives no slots from a script; fill them through visual.slots or a slots pin" });
    expect(plain.spec).toBe("list");
    expect(filledByHand).toMatchObject({ spec: "gantt", slots: { tasks, milestones: [] } });
    expect(filledByHand.fallback).toBeUndefined();
  });
});

describe("template fill: the script", () => {
  it("lists custom-layer beats instead of filling them", () => {
    // Arrange / Act
    const filled = fill(fixtureScript());

    // Assert
    expect(filled.custom).toEqual(["b13"]);
    expect(filled.beats.map((beat) => beat.id)).not.toContain("b13");
  });

  it("carries visual.tune through untouched", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "list", labels: ["tick Two lanes"], tune: { pace: 2, loop: false } });

    // Assert
    expect(found.tune).toEqual({ pace: 2, loop: false });
  });

  it("refuses a beat the resolved artifact has no row for", () => {
    // Arrange
    const script = fixtureScript();

    // Act
    const error = refusalOf(() => fillScript(script, { beats: [] }, { specs: shippedSpecs }));

    // Assert
    expect(error.refusals).toHaveLength(13);
  });

  it("shows a placeholder when the first element lands past 30 % of the words, reading word#n cues", () => {
    // Arrange
    const spoken = "Lanes help. The desk runs two lanes now and the queue stays short today.";

    // Act
    const [late, early] = [fillSolo({ beat: "list", labels: ["tick Two lanes"], cues: [cue("rows-1", "lanes#2")] }, spoken), fillSolo({ beat: "list", labels: ["tick Two lanes"], cues: [cue("rows-1", "lanes")] }, spoken)];

    // Assert
    expect(late.hints.placeholder).toBe(true);
    expect(early.hints.placeholder).toBeUndefined();
  });

  it("fills the same beats from the same script whatever its key order", () => {
    // Arrange
    const reversed = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(reversed) : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)])) : value;
    const shuffled = ScriptSchema.parse(reversed(rawFixture()));

    // Act / Assert
    expect(fill(shuffled)).toEqual(fill(fixtureScript()));
  });
});

describe("template fill: coverage", () => {
  it("has a deriver for every slot schema", () => {
    // Arrange / Act / Assert
    expect(Object.keys(DERIVERS).sort()).toEqual(Object.keys(BEAT_SLOTS).sort());
  });

  it("returns slots that re-parse unchanged with their ref's schema", () => {
    // Arrange / Act
    const { beats } = fill(fixtureScript());

    // Assert
    for (const beat of beats) expect(BEAT_SLOTS[beat.ref].parse(beat.slots)).toEqual(beat.slots);
  });

  it("ships a resolved fixture that is what resolve makes of the fixture script", () => {
    // Arrange
    const committed = ResolvedSchema.parse(JSON.parse(fillFixture("fill.resolved.json")));

    // Act
    const resolved = resolvedFor(fixtureScript());

    // Assert
    expect(committed.beats).toEqual(resolved.beats);
  });
});

// What the spike sample builder writes for each fixture beat, read off its code (its views, cue_words, late_first_cue and the
// S9 continuation), so each field it sets has its place in the fill.
const SAMPLE_BUILDER: Record<string, { heading?: string; cues: string[]; placeholder?: true; qaLeadLine?: true }> = {
  b1: { cues: ["A"] },
  b2: { heading: "The refusal", cues: ["lanes", "lanes", "night"] },
  b3: { heading: "The refusal", cues: ["A", "A", "backlog"] },
  b4: { cues: ["twelve"], placeholder: true },
  b5: { cues: ["before", "before"] },
  b6: { heading: "The scan path", cues: ["scanner", "desk", "ledger", "printer"] },
  b7: { cues: ["Monday"] },
  b8: { heading: "The scan path", cues: ["five", "seven", "six"], placeholder: true },
  b9: { heading: "Desk server → Ledger", cues: ["holds", "slowly"] },
  b10: { heading: "Ship it: two lanes hold", cues: ["minutes", "early"], placeholder: true, qaLeadLine: true },
  b11: { heading: "The call", cues: ["The"] },
  b12: { cues: ["Check"] },
};

const HEADING_SLOT: Record<string, string> = { list: "title", "verdict-card": "verdict", "issue-pin": "title", chart: "title", map: "title" };

describe("template fill: sample builder parity on the fixture", () => {
  const filled = fill(fixtureScript());

  it.each(Object.entries(SAMPLE_BUILDER))("%s keeps every field the sample builder sets", (id, sample) => {
    // Arrange
    const found = filledBeat(filled, id);

    // Act
    const heading = found.slots[HEADING_SLOT[found.ref] ?? ""];

    // Assert
    expect(heading).toBe(sample.heading);
    expect(found.reveals.map((reveal) => reveal.atCue).slice(0, sample.cues.length)).toEqual(sample.cues);
    expect(found.hints.placeholder).toBe(sample.placeholder);
    expect(found.hints.qaLeadLine).toBe(sample.qaLeadLine);
  });
});
