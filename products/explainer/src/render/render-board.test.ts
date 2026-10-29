import { describe, expect, it } from "vitest";
import { ScriptSchema } from "../script-schema.js";
import { fill, filledBeat, fixtureScript, rawFixture, resolvedFor } from "../template-fill/fill-fixtures.test-helpers.js";
import { renderBoard } from "./render-board.js";

// Synthetic: the template-fill fixture's invented parcel desk, with beat b2 resolved to a custom kanban layer.
const SIX_LABELS = ["tick Intake", "tick Sort", "tick Scan", "tick Pack", "tick Label", "tick Dispatch"];

/** The fixture's artifacts with b2 turned custom (a kanban-flow layer) and given `labels`. */
function customInputs(labels: string[]) {
  const raw = rawFixture();
  const script = { ...raw, beats: raw.beats.map((beat) => (beat.id === "b2" ? { ...beat, visual: { ...beat.visual, labels, cues: [] } } : beat)) };
  const rows = resolvedFor(ScriptSchema.parse(script)).beats.map((row) => (row.id === "b2" ? { ...row, beat: "kanban-flow", layer: "custom" as const } : row));
  const resolved = { schema: "explainer.resolved/v1", profile: "tour", beats: rows, budgets: [] };
  const texts = new Map([["s", JSON.stringify(script)], ["r", JSON.stringify(resolved)]]);
  return { artifacts: { script: "s", resolved: "r" }, store: { readText: (sha: string) => texts.get(sha)! } };
}

describe("renderBoard custom beats", () => {
  it("keeps a custom kanban beat whose list fallback is invalid, without refusing it", () => {
    // Arrange
    const input = customInputs(SIX_LABELS);

    // Act
    const { board, custom } = renderBoard(input);

    // Assert
    expect(custom.get("b2")).toBeDefined();
    expect(board.beats.find((beat) => beat.id === custom.get("b2"))).toMatchObject({ type: "kanban-flow", slots: {} });
  });

  it("holds a custom beat whose list fallback would be valid as its custom spec, not a list", () => {
    // Arrange
    const input = customInputs(["tick Two lanes", "cross One queue", "crew · Night shift"]);

    // Act
    const { board, extras, custom } = renderBoard(input);

    // Assert
    const id = custom.get("b2")!;
    expect(board.beats.find((beat) => beat.id === id)).toMatchObject({ type: "kanban-flow", slots: {} });
    expect(extras.has(id)).toBe(false);
  });

  it("keeps the custom beat in script order among the template beats", () => {
    // Arrange
    const input = customInputs(SIX_LABELS);

    // Act
    const { board, ids } = renderBoard(input);

    // Assert
    expect(board.beats.map((beat) => beat.id)).toEqual([...ids.values()]);
  });
});

/** The fixture's artifacts with resolve's `generated-slots` layer stored beside them, as render reads them. */
function pinnedInputs() {
  const script = fixtureScript();
  const generated = Object.fromEntries(fill(script).beats.map((beat) => [beat.id, beat.generated]));
  const resolved = { schema: "explainer.resolved/v1", profile: "tour", beats: resolvedFor(script).beats, budgets: [] };
  const texts = new Map([["s", JSON.stringify(rawFixture())], ["r", JSON.stringify(resolved)], ["g", JSON.stringify(generated)]]);
  return { artifacts: { script: "s", resolved: "r", "generated-slots": "g" }, store: { readText: (sha: string) => texts.get(sha)! } };
}

describe("renderBoard under a slots pin", () => {
  it("a beat filled from the generated-slots pin keeps its cue reveals", () => {
    // Arrange
    const input = pinnedInputs();
    const unpinned = filledBeat(fill(fixtureScript()), "b8").reveals;

    // Act
    const { extras, ids } = renderBoard(input);

    // Assert
    expect(unpinned.map((reveal) => reveal.atCue)).toEqual(["five", "seven", "six"]);
    expect(extras.get(ids.get("b8")!)?.reveals).toEqual(unpinned);
  });
});
