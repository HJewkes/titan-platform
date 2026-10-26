import { describe, expect, it } from "vitest";
import { resolveScript, visual } from "./resolve-fixtures.test-helpers.js";
import { resolveConfig, runResolveStage } from "./resolve-stage.js";
import { sha256 } from "./workflow/artifacts.js";
import { runStageChecks } from "./workflow/stage-checks.js";

const json = (value: unknown): string => JSON.stringify(value);

/** The resolve stage body over an in-memory store holding `texts`, then its checks over its inputs and outputs. */
function filledThenChecks(texts: Record<string, string>) {
  const bySha = new Map(Object.values(texts).map((text) => [sha256(text), text]));
  const writes: string[] = [];
  const store = { readText: (sha: string) => bySha.get(sha)!, putText: (text: string, kind: string) => (writes.push(kind), bySha.set(sha256(text), text), sha256(text)) };
  const inputs = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha256(text)]));
  const outcome = runResolveStage({ artifacts: inputs, store, from: { runId: "r", stage: "resolve" }, remainingUsd: 1 }, resolveConfig());
  const checks = runStageChecks("resolve", { artifacts: { ...inputs, ...outcome.outputs }, store, l0Checks: [] });
  const generated = outcome.outputs["generated-slots"];
  const slots = generated === undefined ? undefined : JSON.parse(store.readText(generated));
  return { writes, outcome, checks, slots, check: (name: string) => checks.checks.find((check) => check.name === name) };
}

// Synthetic parcel-desk beats for the template fill at resolve; nothing here quotes a real script or video.
const cue = (target: string, atCue: string) => ({ action: "V6", target, atCue });
const listBeat = visual({ beat: "list", labels: ["tick Two lanes", "cross One queue"], cues: [cue("rows-2", "ledger")] });
const compareBeat = (labels: string[], cues = [cue("rows-4", "parcel")]) => visual({ beat: "compare", labels, cues });
const PAIRED = ["before: One queue", "after: Two lanes", "before: Hand checks", "after: Ledger checks"];
const scriptOf = (...beats: Record<string, unknown>[]): string => json(resolveScript(beats.map((beat, i) => [`b${i + 1}`, "WHAT", { visual: beat }])));

describe("resolve stores the template fill's slots", () => {
  it("writes each beat's generated slots by beat id when no slots pin is present, and the emphasis gate runs on them", () => {
    // Arrange / Act
    const { slots, check, checks } = filledThenChecks({ script: scriptOf(listBeat) });

    // Assert
    expect(slots).toEqual({ b1: { title: expect.any(String), rows: [{ id: "rows-1", text: "Two lanes", mark: "tick" }, { id: "rows-2", text: "One queue", mark: "cross" }] } });
    expect(checks.notes).toEqual(["check sim-check skipped: no sim-traces artifact"]);
    expect(check("emphasis-target")).toEqual({ name: "emphasis-target", gate: true, pass: true, detail: "0 of 1 emphasis cues fail" });
  });

  it("fills over a slots pin and never writes slots, so the pin's sha stands", () => {
    // Arrange
    const pinned = { rows: [{ id: "rows-2", text: "Pinned row", mark: "dot" }] };

    // Act
    const { writes, outcome, slots, check } = filledThenChecks({ script: scriptOf(listBeat), slots: json({ b1: pinned }) });

    // Assert
    expect(outcome.outputs).not.toHaveProperty("slots");
    expect(writes).toEqual(["resolved", "generated-slots"]);
    expect(slots).toEqual({ b1: pinned });
    expect(check("emphasis-target")).toMatchObject({ pass: true });
  });

  it("reads a carried generated-slots artifact as nothing, filling fresh from the script", () => {
    // Arrange
    const stale = json({ b1: { title: "Stale", rows: [{ id: "rows-1", text: "Stale row", mark: "dot" }] } });

    // Act
    const { slots, check } = filledThenChecks({ script: scriptOf(listBeat), "generated-slots": stale });

    // Assert
    expect(slots.b1.rows.map((row: { text: string }) => row.text)).toEqual(["Two lanes", "One queue"]);
    expect(check("emphasis-target")).toMatchObject({ pass: true, detail: "0 of 1 emphasis cues fail" });
  });

  it("lights the fourth label of a four-label compare, since compare ids are numbered per label", () => {
    // Arrange / Act
    const { slots, check } = filledThenChecks({ script: scriptOf(compareBeat(PAIRED)) });

    // Assert
    expect(slots.b1.rows.map((row: { id: string; alias: string }) => [row.id, row.alias])).toEqual([["rows-1", "rows-2"], ["rows-3", "rows-4"]]);
    expect(check("emphasis-target")).toMatchObject({ pass: true, detail: "0 of 1 emphasis cues fail" });
  });

  it("fails the emphasis gate on a compare cue past the last label", () => {
    // Arrange / Act
    const { check } = filledThenChecks({ script: scriptOf(compareBeat(PAIRED, [cue("rows-5", "parcel")])) });

    // Assert
    expect(check("emphasis-target")).toMatchObject({ pass: false, detail: "1 of 1 emphasis cues fail: b1#0 no-element" });
  });
});

describe("template-fill gate on the resolve stage", () => {
  it("passes a beat that falls back and names the fallback, its cues read against the list it draws", () => {
    // Arrange / Act
    const { check } = filledThenChecks({ script: scriptOf(listBeat, compareBeat(["before: One queue", "before: Hand checks"], [cue("rows-2", "parcel")])) });

    // Assert
    expect(check("template-fill")).toMatchObject({ gate: true, pass: true, detail: expect.stringMatching(/^2 beats filled, 1 by fallback: b2 compare → list \(.*both/) });
    expect(check("emphasis-target")).toMatchObject({ pass: true });
  });

  it("fails the stage on an override that leaves the fill invalid, naming the beat", () => {
    // Arrange
    const unpaired = { ...compareBeat(["One queue", "Two lanes"], []), slots: { leftTitle: "Old desk" } };

    // Act
    const { check, slots } = filledThenChecks({ script: scriptOf(listBeat, unpaired) });

    // Assert
    expect(check("slot-overrides")).toMatchObject({ pass: true });
    expect(check("template-fill")).toMatchObject({ gate: true, pass: false, detail: expect.stringMatching(/^template fill refused 1 beat: b2 \(visual\.slots leave compare invalid/) });
    expect(slots).toBeUndefined();
    expect(check("emphasis-target")).toMatchObject({ pass: false, detail: expect.stringContaining("the template fill refused") });
  });

  it("passes a partial override on a beat whose slots come from the pin, as the render fills it", () => {
    // Arrange
    const pinned = filledThenChecks({ script: scriptOf(compareBeat(PAIRED)) }).slots;
    const unpaired = { ...compareBeat(["One queue", "Two lanes"], []), slots: { leftTitle: "Old desk" } };

    // Act
    const { check, slots } = filledThenChecks({ script: scriptOf(unpaired), slots: json(pinned) });

    // Assert
    expect(check("template-fill")).toMatchObject({ gate: true, pass: true, detail: "1 beats filled, 0 by fallback" });
    expect(slots).toEqual(pinned);
  });
});
