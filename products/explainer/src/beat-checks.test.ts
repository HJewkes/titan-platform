import { describe, expect, it } from "vitest";
import { checkBeatSpecs, type BeatIssueCode } from "./beat-checks.js";
import { beatSpec, BEATS } from "./beat-fixtures.test-helpers.js";
import { loadBeatSpecs } from "./beat-load.js";
import type { BeatSpec } from "./beat-schema.js";
import { VOCABULARY } from "./doctrine-fixtures.test-helpers.js";
import { loadDoctrine } from "./doctrine-load.js";

const codes = (...extra: BeatSpec[]): BeatIssueCode[] => {
  const specs = new Map([...BEATS, ...extra.map((spec): [string, BeatSpec] => [spec.type, spec])]);
  return checkBeatSpecs(specs, VOCABULARY).map((found) => found.code);
};

describe("checkBeatSpecs", () => {
  it("finds nothing in the sound fixture registry", () => {
    expect(codes()).toEqual([]);
  });

  it.each<[string, BeatSpec, BeatIssueCode]>([
    ["a beat missing from the vocabulary", beatSpec("timeline-strip"), "unknown-vocabulary"],
    ["a slots ref with no schema", beatSpec("code-walk", { slots: "code-tour" }), "unknown-slots"],
    ["a default duration above the maximum", beatSpec("code-walk", { durationS: [5, 30, 20] }), "duration-order"],
    ["a minimum duration above the default", beatSpec("code-walk", { durationS: [12, 10, 20] }), "duration-order"],
    ["a recipe over 200 words", beatSpec("code-walk", { recipe: Array.from({ length: 201 }, () => "word").join(" ") }), "recipe-length"],
    ["an emphasis target that is not a slot", beatSpec("code-walk", { emphasis: { targets: ["rows"], treatments: ["highlight"] } }), "emphasis-target"],
    ["an emphasis target that is not a list", beatSpec("code-walk", { emphasis: { targets: ["path"], treatments: ["highlight"] } }), "emphasis-target"],
    ["an emphasis target whose items carry no id", beatSpec("code-walk", { slots: "dsm", emphasis: { targets: ["cells"], treatments: ["highlight"] } }), "emphasis-target"],
  ])("reports %s", (_name, spec, code) => {
    expect(codes(spec)).toEqual([code]);
  });

  it("accepts a recipe of exactly 200 words", () => {
    expect(codes(beatSpec("code-walk", { recipe: Array.from({ length: 200 }, () => "word").join(" ") }))).toEqual([]);
  });

  it("accepts an emphasis target behind a slot default", () => {
    expect(codes(beatSpec("hook", { slots: "hook", emphasis: { targets: ["cards"], treatments: ["scale"] } }))).toEqual([]);
  });

  it("reports a vocabulary beat with no spec", () => {
    const specs = new Map([...BEATS].filter(([type]) => type !== "hook"));

    expect(checkBeatSpecs(specs, VOCABULARY).map((found) => found.code)).toEqual(["missing-beat-spec"]);
  });

  it("finds nothing in the shipped specs against the shipped vocabulary", () => {
    expect(checkBeatSpecs(loadBeatSpecs(), loadDoctrine().vocabulary)).toEqual([]);
  });
});
