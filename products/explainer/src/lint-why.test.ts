import { describe, expect, it } from "vitest";
import { deriveEvalView } from "./eval-view.js";
import { goodScript, passALike, passALikeTour } from "./lint-fixtures.test-helpers.js";
import { whyCheck } from "./lint-why.js";
import type { ScriptV1 } from "./script-schema.js";

const rows = (script: ScriptV1) => whyCheck({ script, view: deriveEvalView(script) });
const rowFor = (script: ScriptV1, id: string) => rows(script).find((row) => row.check_id === id);
const withBeat = (script: ScriptV1, id: string, patch: Record<string, unknown>): ScriptV1 => ({
  ...script,
  beats: script.beats.map((beat) => (beat.id === id ? { ...beat, ...patch } : beat)),
});

describe("why, value and thread lints", () => {
  it("passes every rule on a script that follows the template", () => {
    const failing = rows(goodScript()).filter((row) => !row.pass);

    expect(failing).toEqual([]);
  });

  it("reports one row per rule, so a pass is recorded too", () => {
    const ids = rows(goodScript()).map((row) => row.check_id);

    expect(ids).toEqual(["Q-W1", "Q-W2", "Q-W3", "Q-W4", "Q-W5", "Q-W6", "Q-W8", "Q-W9", "Q-W10", "Q-F3", "Q-F12", "Q-F13"]);
  });

  it("finds that only one of five body chapters in a pass-A-like script leads with why", () => {
    const row = rowFor(passALike(), "Q-W3");

    expect(row).toMatchObject({ pass: false, value: 4, mode: "heuristic" });
    expect(row?.detail_beats).toEqual(["c3-2-cli", "c4-2-parts", "c5-2-walk", "c6-2-grammar"]);
  });

  it("fails the thread when the walk follows a different call from the hook, though the hook's words recur", () => {
    const hookWords = ["label", "shelf"];
    const chaptersWithHookWords = new Set(
      passALikeTour.beats.filter((beat) => hookWords.some((word) => beat.spoken.includes(word))).map((beat) => beat.chapter),
    );

    const walkAnchor = rowFor(passALike("label ten to twenty"), "Q-F3");
    const hookAnchor = rowFor(passALike("label forty to forty-eight"), "Q-F3");

    expect(chaptersWithHookWords.size / passALikeTour.chapters.length).toBeGreaterThanOrEqual(0.5);
    expect(walkAnchor?.pass).toBe(false);
    expect(hookAnchor?.pass).toBe(false);
  });

  it("fails the thread when no running example is authored", () => {
    expect(rowFor(passALike(), "Q-F3")).toMatchObject({ pass: false, value: 1 });
  });

  it("fails the stake when it is voiced after the first 15 percent", () => {
    const good = goodScript();
    const late = { ...good, beats: [...good.beats.filter((b) => b.id !== "b2"), ...good.beats.filter((b) => b.id === "b2")] };

    expect(rowFor(late, "Q-W1")).toMatchObject({ pass: false, detail_beats: [], value: 1 });
  });

  it("fails a stake beat with no number", () => {
    const script = withBeat(goodScript(), "b2", { spoken: "You lose time on every wrong label." });

    expect(rowFor(script, "Q-W1")).toMatchObject({ pass: false, detail_beats: ["b2"] });
  });

  it("fails a beat that introduces a term with no cited why", () => {
    const script = withBeat(goodScript(), "b5", { why: undefined });

    expect(rowFor(script, "Q-W2")?.detail_beats).toEqual(["b5"]);
  });

  it("fails a body chapter with no user-value sentence", () => {
    const script = withBeat(goodScript(), "b9", { user_value: undefined });

    expect(rowFor(script, "Q-W4")?.detail_beats).toEqual(["b9"]);
  });

  it.each([
    ["no you", "The desk catches a bad label before it prints."],
    ["a tour", "You get a tour of parcel-desk."],
    ["a chapter count", "You will see it in five short chapters."],
  ])("fails a promise with %s", (_case, promise) => {
    const good = goodScript();
    const script = { ...good, video: { ...good.video, promise } };

    expect(rowFor(script, "Q-W5")?.pass).toBe(false);
  });

  it("fails a HOW chapter that speaks no invariant or absence", () => {
    const script = withBeat(goodScript(), "b6", { spoken: "The desk server reads parcel P-7 from the ledger." });

    expect(rowFor(script, "Q-W6")?.detail_beats).toEqual(["b6"]);
  });

  it("fails a fence that is not drawn as a design", () => {
    const script = withBeat(goodScript(), "b4", { visual: { ...goodScript().beats[3]!.visual, job: "numbers" } });

    expect(rowFor(script, "Q-W8")?.detail_beats).toEqual(["b4"]);
  });

  it("fails design history that cites no commit sha", () => {
    const history = { tried: "a batch path", failed_because: "double prints", changed_to: "one check", source_sha: "last spring" };
    const script = withBeat(goodScript(), "b8", { design_history: history });

    expect(rowFor(script, "Q-W9")?.detail_beats).toEqual(["b8"]);
  });

  it("fails a HOW chapter that names none of the declared quality goals", () => {
    const good = goodScript();
    const script = { ...good, video: { ...good.video, quality_goals: [{ id: "QG1", goal: "no double prints", scenario: "two scans" }] } };

    expect(rowFor(script, "Q-W10")?.detail_beats).toEqual(["ch3"]);
  });

  it("fails a caveat placed after the close", () => {
    const good = goodScript();
    const script = { ...good, beats: [...good.beats.filter((b) => b.id !== "b9"), good.beats.find((b) => b.id === "b9")!] };

    expect(rowFor(script, "Q-F12")?.detail_beats).toEqual(["b9"]);
  });

  it("fails a demo beat that shows no step", () => {
    const script = withBeat(goodScript(), "b7", { visual: { assertion: "The scan answers refused", job: "code-proof", cues: [], chips: [], labels: [], edge_sources: [] } });

    expect(rowFor(script, "Q-F13")?.detail_beats).toEqual(["b7"]);
  });
});
