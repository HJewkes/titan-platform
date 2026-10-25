import { describe, expect, it } from "vitest";
import { ResolvedSchema } from "../resolve-stage.js";
import type { ScriptV1 } from "../script-schema.js";
import { fillFixture, fixtureScript } from "../template-fill/fill-fixtures.test-helpers.js";
import { beatProps, saveBackOf, SETTLE_LEAD_S, type BeatProps } from "./beat-props.js";

// Synthetic: the template fill's invented parcel desk, voiced on a made-up clock of 0.4 s a word.
const WORD_S = 0.4;

const resolvedFixture = () => ResolvedSchema.parse(JSON.parse(fillFixture("fill.resolved.json")));

/** A words artifact laying each beat end to end, a word every 0.4 s; `durations` replaces a beat's heard length. */
function wordsFor(script: ScriptV1, durations: Record<string, number> = {}) {
  let startS = 0;
  const beats = script.beats.map((beat) => {
    const spoken = beat.spoken.split(/\s+/);
    const row = { id: beat.id, startS, durationS: durations[beat.id] ?? spoken.length * WORD_S + 0.2, words: spoken.map((word, i) => ({ word, start: i * WORD_S })) };
    startS += row.durationS;
    return row;
  });
  return { schema: "explainer.words/v1", beats };
}

function withVisual(script: ScriptV1, id: string, visual: Partial<ScriptV1["beats"][number]["visual"]>): ScriptV1 {
  return { ...script, beats: script.beats.map((beat) => (beat.id === id ? { ...beat, visual: { ...beat.visual, ...visual } } : beat)) };
}

const propsFor = (script = fixtureScript(), resolved = resolvedFixture(), words = wordsFor(script)): BeatProps[] => beatProps({ script, resolved, words });
const beat = (props: BeatProps[], id: string): BeatProps => props.find((b) => b.id === id)!;

describe("explainer props: each template beat", () => {
  it("carries the JSON Schema of the slot ref its spec names", () => {
    const props = propsFor();

    const compare = beat(props, "b5");

    expect(compare).toMatchObject({ chapter: "ch2", spec: "compare", slots: "compare" });
    expect(compare.schema).toMatchObject({ properties: { rows: { maxItems: 4 }, leftTitle: { maxLength: 48 } } });
  });

  it("shows an owner override over the derived fill and lists the field as overridden", () => {
    const script = withVisual(fixtureScript(), "b5", { slots: { leftTitle: "Old desk" } });
    const derived = beat(propsFor(), "b5");

    const edited = beat(propsFor(script), "b5");

    expect(derived.value.leftTitle).not.toBe("Old desk");
    expect(edited.value.leftTitle).toBe("Old desk");
    expect(edited.overridden).toEqual(["leftTitle"]);
    expect(derived.overridden).toEqual([]);
  });

  it("locks the element ids its cues target", () => {
    const props = propsFor();

    expect(beat(props, "b2").locked).toEqual(["rows-1", "rows-3"]);
    expect(beat(props, "b9").locked).toEqual([]);
  });

  it("leaves out a beat resolve cut and a custom-layer beat", () => {
    const resolved = { ...resolvedFixture(), cut: [{ id: "b9", chapter: "ch2", code: "sim-failed", detail: "synthetic cut" }] };

    const ids = propsFor(fixtureScript(), resolved).map((b) => b.id);

    expect(ids).not.toContain("b9");
    expect(ids).not.toContain("b13");
    expect(ids).toContain("b10");
  });
});

describe("explainer props: timing", () => {
  it("places each beat on the words clock and stills it just before its end", () => {
    const script = fixtureScript();
    const words = wordsFor(script);
    const row = words.beats.find((b) => b.id === "b3")!;

    const b3 = beat(propsFor(script, resolvedFixture(), words), "b3");

    expect(b3.startS).toBeCloseTo(row.startS);
    expect(b3.endS).toBeCloseTo(row.startS + row.durationS);
    expect(b3.stillS).toBeCloseTo(b3.endS - SETTLE_LEAD_S);
  });

  it("stills a beat whose last cue fires inside the settle lead at that cue", () => {
    const script = fixtureScript();
    const nightAt = script.beats.find((b) => b.id === "b2")!.spoken.split(/\s+/).indexOf("night") * WORD_S;
    const words = wordsFor(script, { b2: nightAt + 0.1 });

    const b2 = beat(propsFor(script, resolvedFixture(), words), "b2");

    expect(b2.stillS).toBeCloseTo(b2.startS + nightAt);
  });
});

describe("explainer props: save-back", () => {
  it("stays off while render is a bridge stage, even once the render reads the fill", () => {
    expect(saveBackOf({ bridged: true, readsFill: true })).toEqual({ enabled: false, reason: "renders ignore edits until TP-2992 S3" });
  });

  it("stays off for an in-process render that does not read the fill, and turns on when it does", () => {
    expect(saveBackOf({ bridged: false, readsFill: false }).enabled).toBe(false);
    expect(saveBackOf({ bridged: false, readsFill: true })).toEqual({ enabled: true });
  });

  it("is off today, with render bridged", () => {
    expect(saveBackOf()).toMatchObject({ enabled: false, reason: expect.stringContaining("TP-2992 S3") });
  });
});
