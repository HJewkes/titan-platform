import { describe, expect, it } from "vitest";
import { evidenceCheck } from "./lint-evidence.js";
import { goodScript } from "./lint-fixtures.test-helpers.js";
import { deriveEvalView } from "./eval-view.js";
import type { ScriptV1 } from "./script-schema.js";

const rowFor = (script: ScriptV1, id: string) => evidenceCheck({ script, view: deriveEvalView(script) }).find((row) => row.check_id === id);
const withBeat = (script: ScriptV1, id: string, patch: Record<string, unknown>): ScriptV1 => ({
  ...script,
  beats: script.beats.map((beat) => (beat.id === id ? { ...beat, ...patch } : beat)),
});

describe("evidence lints", () => {
  it("passes every rule on a script that cites its facts", () => {
    const script = goodScript();

    const rows = evidenceCheck({ script, view: deriveEvalView(script) });

    expect(rows.map((row) => [row.check_id, row.pass])).toEqual([
      ["Q-E1", true],
      ["Q-E2", true],
      ["Q-E3", true],
      ["Q-E4", true],
    ]);
  });

  it("fails a claim beat with no fact id", () => {
    expect(rowFor(withBeat(goodScript(), "b6", { fact_ids: [] }), "Q-E1")?.detail_beats).toEqual(["b6"]);
  });

  it("fails a verified chip that names no fact", () => {
    const visual = { ...goodScript().beats[0]!.visual, chips: [{ kind: "verified", text: "verified at the pin" }] };

    expect(rowFor(withBeat(goodScript(), "b1", { visual }), "Q-E1")?.detail_beats).toEqual(["b1"]);
  });

  it("fails a running example that cites no fact", () => {
    const good = goodScript();
    const script = { ...good, video: { ...good.video, running_example: { scenario: "A scan.", anchor: "parcel P-7", fact_ids: [] } } };

    expect(rowFor(script, "Q-E2")).toMatchObject({ pass: false, value: 1 });
  });

  it("fails a verdict beat under the public profile, and allows it under the default one", () => {
    const withVerdict = withBeat(goodScript(), "b9", { function: "VERDICT" });

    expect(rowFor({ ...withVerdict, profile: "repo-tour-public" }, "Q-E3")?.detail_beats).toEqual(["b9"]);
    expect(rowFor(withVerdict, "Q-E3")?.pass).toBe(true);
  });

  it("fails a new term missing from the glossary", () => {
    expect(rowFor(withBeat(goodScript(), "b6", { new_terms: ["ledger"] }), "Q-E4")?.detail_beats).toEqual(["b6"]);
  });

  it("fails a chapter that introduces five names, and passes four", () => {
    const good = goodScript();
    const names = ["desk server", "ledger", "shelf", "scanner", "courier app"];
    const glossed = { ...good, video: { ...good.video, glossary: names.map((name) => ({ name, job: "a part" })) } };

    const five = withBeat(withBeat(glossed, "b6", { new_terms: names.slice(0, 3) }), "b7", { new_terms: names.slice(3) });
    const four = withBeat(withBeat(glossed, "b6", { new_terms: names.slice(0, 2) }), "b7", { new_terms: names.slice(2, 4) });

    expect(rowFor(five, "Q-E4")?.detail_beats).toEqual(["b6", "b7"]);
    expect(rowFor(four, "Q-E4")?.pass).toBe(true);
  });
});
