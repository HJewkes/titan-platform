import { describe, expect, it } from "vitest";
import { loadDoctrine } from "./doctrine-load.js";
import { checkProfiles, type ProfileIssueCode } from "./profile-checks.js";
import { fixedProfile, HEURISTIC as heuristic, heuristicProfile, PROFILE_VOCABULARY, setOf } from "./profile-fixtures.test-helpers.js";
import { loadProfiles } from "./profile-load.js";
import type { TypeProfile } from "./profile-schema.js";

const codes = (...profiles: TypeProfile[]): ProfileIssueCode[] => checkProfiles(setOf(...profiles), PROFILE_VOCABULARY).map((found) => found.code);

describe("checkProfiles", () => {
  it("finds nothing in the sound fixed and heuristic fixtures", () => {
    expect(codes(fixedProfile(), heuristicProfile())).toEqual([]);
  });

  it.each<[string, TypeProfile, ProfileIssueCode]>([
    ["a block beat missing from the vocabulary", fixedProfile({ structure: { order: "fixed", macro: "scqa-c4", blocks: [{ id: "a", goal: "g", seconds: [1, 2], beats: ["verdict-card"] }] } }), "unknown-vocabulary"],
    ["a cut whose type is missing from the vocabulary", fixedProfile({ cuts: [{ id: "brief", type: "decision-brief", when: "w", runtimeS: [45, 90] }] }), "unknown-vocabulary"],
    ["an allowed audience with no pack", fixedProfile({ audience: { default: "owner-internal", allow: ["owner-internal", "investors"] } }), "unknown-audience"],
    ["a default audience outside allow", fixedProfile({ audience: { default: "public-youtube", allow: ["owner-internal"] } }), "audience-not-allowed"],
    ["a macro naming a missing block", heuristicProfile({ structure: { ...heuristic, macros: { ...heuristic.macros, abt: ["setup", "ghost"] } } }), "dangling-ref"],
    ["a heuristic row naming a missing macro", heuristicProfile({ structure: { ...heuristic, fallback: "scqa-c4" } }), "dangling-ref"],
    ["a fixed macro with no registered structure", fixedProfile({ structure: { ...fixedProfile().structure, macro: "freytag" } }), "unknown-structure"],
    ["a heuristic macro with no registered structure", heuristicProfile({ structure: { ...heuristic, macros: { ...heuristic.macros, freytag: ["setup"] }, fallback: "freytag" } }), "unknown-structure"],
    ["a target above the max", fixedProfile({ runtime: { targetS: 800, minS: 480, maxS: 720, splitAboveS: 900 } }), "runtime-order"],
    ["a field both repeated and varied", fixedProfile({ series: { mayRepeat: ["hook-kind"], mustVary: fixedProfile().series.mustVary } }), "series-overlap"],
    ["mustVary without the style pack", fixedProfile({ series: { mayRepeat: [], mustVary: ["hook-kind", "close-kind", "function-mix", "component-histogram"] } }), "series-base-missing"],
    ["a fixed order that must vary its chapter labels", fixedProfile({ series: { mayRepeat: [], mustVary: [...fixedProfile().series.mustVary, "chapter-labels"] } }), "series-structure-mismatch"],
    ["a heuristic order that lets its structure repeat", heuristicProfile({ series: { mayRepeat: ["structure"], mustVary: fixedProfile().series.mustVary } }), "series-structure-mismatch"],
    ["a publishable audience with no owner ask", fixedProfile({ audience: { default: "owner-internal", allow: ["owner-internal", "public-youtube"] } }), "publish-unguarded"],
    ["a paper profile without the re-plot check", fixedProfile({ family: "review-paper", publish: { ownerAskPerVideo: true, checks: ["quotes-short"] } }), "publish-unguarded"],
  ])("reports %s", (_name, profile, code) => {
    expect(codes(profile)).toEqual([code]);
  });

  it("finds nothing in the shipped profiles against the shipped vocabulary", () => {
    expect(checkProfiles(loadProfiles(), loadDoctrine().vocabulary)).toEqual([]);
  });
});
