import { describe, expect, it } from "vitest";
import { resolveScript, visual } from "./resolve-fixtures.test-helpers.js";
import { readEmphasisInput, resolveConfig, runResolveStage } from "./resolve-stage.js";
import { ScriptSchema } from "./script-schema.js";
import { sha256 } from "./workflow/artifacts.js";
import { runStageChecks } from "./workflow/stage-checks.js";

// Synthetic: an invented parcel desk with three beats; nothing here quotes a real script or video.
type Overrides = { b1?: Record<string, unknown>; b2?: Record<string, unknown>; b3?: Record<string, unknown> };

const cue = { action: "V6", target: "new-lane", atCue: "ledger" };

function threeBeats(overrides: Overrides = {}) {
  return resolveScript([
    ["b1", "WHAT", { visual: visual({ beat: "list", labels: ["two lanes"], ...overrides.b1 }) }],
    ["b2", "WHAT", { visual: visual({ beat: "compare", labels: ["old", "new"], cues: [cue], ...overrides.b2 }) }],
    ["b3", "HOW", { visual: visual({ beat: "chart", layer: "custom", labels: ["4 a day"], ...overrides.b3 }) }],
  ]);
}

const generatedSlots = { b2: { leftTitle: "Before", rightTitle: "After", rows: [{ id: "old-lane", left: "One queue", right: "Two queues" }] } };

/** The resolve stage body and then its checks, over an in-memory store holding `texts`. */
function resolveThenCheck(texts: Record<string, string>) {
  const bySha = new Map(Object.values(texts).map((text) => [sha256(text), text]));
  const store = { readText: (sha: string) => bySha.get(sha)!, putText: (text: string) => (bySha.set(sha256(text), text), sha256(text)) };
  const inputs = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha256(text)]));
  const outcome = runResolveStage({ artifacts: inputs, store, from: { runId: "r", stage: "resolve" }, remainingUsd: 1 }, resolveConfig());
  const input = { artifacts: { ...inputs, ...outcome.outputs }, store, l0Checks: [] };
  const run = runStageChecks("resolve", input);
  return { resolvedText: store.readText(outcome.outputs.resolved!), input, check: (name: string) => run.checks.find((check) => check.name === name) };
}

const json = (value: unknown): string => JSON.stringify(value);

describe("owner slot overrides on script/v1", () => {
  it("a valid override wins over the generated slot value and keeps the fields it leaves alone", () => {
    const rows = [{ id: "new-lane", left: "One shelf", right: "Two shelves" }];
    const script = threeBeats({ b2: { slots: { rows } } });

    const { input, check } = resolveThenCheck({ script: json(script), slots: json(generatedSlots) });

    expect(readEmphasisInput(input).slots.b2).toEqual({ leftTitle: "Before", rightTitle: "After", rows });
    expect(check("emphasis-target")).toMatchObject({ pass: true });
    expect(check("slot-overrides")).toEqual({ name: "slot-overrides", gate: true, pass: true, detail: "1 beats carry overrides, all accepted" });
  });

  it("without the override the generated slots stand, so the cue on the new row names no element", () => {
    const { check } = resolveThenCheck({ script: json(threeBeats()), slots: json(generatedSlots) });

    expect(check("emphasis-target")).toMatchObject({ pass: false });
  });

  it("an override the slot schema rejects fails the gate with a hint naming its path", () => {
    const script = threeBeats({ b2: { slots: { leftTitle: "x".repeat(49) } } });

    const { check } = resolveThenCheck({ script: json(script) });

    expect(check("slot-overrides")).toMatchObject({ gate: true, pass: false });
    expect(check("slot-overrides")?.detail).toMatch(/^refused overrides: beats\.b2\.visual\.slots\.leftTitle: Too big/);
  });

  it("an override deep in an array names the row and field it breaks", () => {
    const script = threeBeats({ b2: { slots: { rows: [{ id: "Not Kebab", left: "One shelf", right: "Two shelves" }] } } });

    const { check } = resolveThenCheck({ script: json(script) });

    expect(check("slot-overrides")?.detail).toBe("refused overrides: beats.b2.visual.slots.rows.0.id: expected a kebab-case element id");
  });

  it("an override naming a field the beat spec lacks fails the gate", () => {
    const script = threeBeats({ b1: { slots: { colour: "teal" } } });

    const { check } = resolveThenCheck({ script: json(script) });

    expect(check("slot-overrides")).toMatchObject({ pass: false, detail: "refused overrides: beats.b1.visual.slots.colour: beat spec list has no slot colour" });
  });

  it("refuses slot or tune overrides on a custom-layer beat", () => {
    const script = threeBeats({ b3: { slots: { kind: "line" }, tune: { stagger: 0.2 } } });

    const { check } = resolveThenCheck({ script: json(script) });

    expect(check("slot-overrides")).toMatchObject({
      pass: false,
      detail: "refused overrides: beats.b3.visual: slot and tune overrides apply only to template beats; this beat's layer is custom",
    });
  });

  it("an old script with neither field parses without them and resolves to the same bytes as one carrying overrides", () => {
    const old = threeBeats();
    const overridden = threeBeats({ b1: { slots: { title: "Lanes" } }, b2: { tune: { stagger: 0.2 } } });

    const plain = resolveThenCheck({ script: json(old) });
    const withOverrides = resolveThenCheck({ script: json(overridden) });

    expect(ScriptSchema.parse(old).beats[0]!.visual).not.toHaveProperty("slots");
    expect(ScriptSchema.parse(old).beats[0]!.visual).not.toHaveProperty("tune");
    expect(withOverrides.resolvedText).toBe(plain.resolvedText);
    expect(plain.check("slot-overrides")).toMatchObject({ pass: true, detail: "0 beats carry overrides, all accepted" });
  });
});
