import { describe, expect, it } from "vitest";
import { ScriptSchema } from "../script-schema.js";
import { shippedSpecs } from "../resolve-fixtures.test-helpers.js";
import { fill, filledBeat, fixtureScript, rawFixture, resolvedFor } from "../template-fill/fill-fixtures.test-helpers.js";
import { fillScript } from "../template-fill/fill.js";
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

type Rows = ReturnType<typeof resolvedFor>["beats"];

/** The fixture's artifacts (rows patched by `rows`) with resolve's `generated-slots` layer stored beside them, as render reads them. */
function pinnedInputs(raw = rawFixture(), rows: (found: Rows) => Rows = (found) => found) {
  const script = ScriptSchema.parse(raw);
  const beats = rows(resolvedFor(script).beats);
  const atResolve = fillScript(script, { beats }, { specs: shippedSpecs });
  const generated = Object.fromEntries(atResolve.beats.map((beat) => [beat.id, beat.generated]));
  const resolved = { schema: "explainer.resolved/v1", profile: "tour", beats, budgets: [] };
  const texts = new Map([["s", JSON.stringify(raw)], ["r", JSON.stringify(resolved)], ["g", JSON.stringify(generated)]]);
  return { atResolve, artifacts: { script: "s", resolved: "r", "generated-slots": "g" }, store: { readText: (sha: string) => texts.get(sha)! } };
}

/** The fixture with b2 resolved to a button whose labels give a line and no action, so its deriver names the outro fallback. */
function buttonWithoutAction() {
  const raw = rawFixture();
  const script = { ...raw, beats: raw.beats.map((beat) => (beat.id === "b2" ? { ...beat, visual: { ...beat.visual, labels: ["Sign off the night shift"], cues: [] } } : beat)) };
  return pinnedInputs(script, (rows) => rows.map((row) => (row.id === "b2" ? { ...row, beat: "button" } : row)));
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

  it("a pinned beat that fell back at resolve renders as the same fallback kind", () => {
    // Arrange
    const input = buttonWithoutAction();
    const atResolve = filledBeat(input.atResolve, "b2");

    // Act
    const { board, ids } = renderBoard(input);

    // Assert
    expect(atResolve).toMatchObject({ spec: "outro", fallback: { from: "button" } });
    expect(board.beats.find((beat) => beat.id === ids.get("b2"))).toMatchObject({ type: "outro", slots: atResolve.slots });
  });
});
