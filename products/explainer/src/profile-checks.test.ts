import { describe, expect, it } from "vitest";
import { loadDoctrine } from "./doctrine-load.js";
import { checkProfiles, type ProfileIssueCode } from "./profile-checks.js";
import { fixedProfile, HEURISTIC as heuristic, heuristicProfile, PROFILE_VOCABULARY, setOf } from "./profile-fixtures.test-helpers.js";
import { loadProfiles } from "./profile-load.js";
import type { SystemBinding, TypeProfile } from "./profile-schema.js";

const blockOf = (id: string, ...beats: string[]) => ({ id, goal: `${id} goal.`, seconds: [10, 20] as [number, number], beats });

/** A fixed profile binding one beat system over `blocks`. */
const bound = (binding: SystemBinding, blocks = [blockOf("open", "hook"), blockOf("close", "hook")]): TypeProfile =>
  fixedProfile({ structure: { order: "fixed", macro: "scqa-c4", blocks, systems: [binding] } });

const codes = (...profiles: TypeProfile[]): ProfileIssueCode[] => checkProfiles(setOf(...profiles), PROFILE_VOCABULARY).map((found) => found.code);

describe("checkProfiles", () => {
  it("finds nothing in the sound fixed and heuristic fixtures", () => {
    expect(codes(fixedProfile(), heuristicProfile())).toEqual([]);
  });

  it.each<[string, TypeProfile, ProfileIssueCode]>([
    ["a block beat missing from the vocabulary", fixedProfile({ structure: { order: "fixed", macro: "scqa-c4", blocks: [{ id: "a", goal: "g", seconds: [1, 2], beats: ["verdict-card"] }], systems: [] } }), "unknown-vocabulary"],
    ["a cut whose type is missing from the vocabulary", fixedProfile({ cuts: [{ id: "brief", type: "decision-brief", when: "w", runtimeS: [45, 90] }] }), "unknown-vocabulary"],
    ["an allowed audience with no pack", fixedProfile({ audience: { default: "owner-internal", allow: ["owner-internal", "investors"], kind: "assigned" } }), "unknown-audience"],
    ["a default audience outside allow", fixedProfile({ audience: { default: "public-youtube", allow: ["owner-internal"], kind: "assigned" } }), "audience-not-allowed"],
    ["a macro naming a missing block", heuristicProfile({ structure: { ...heuristic, macros: { ...heuristic.macros, abt: ["setup", "ghost"] } } }), "dangling-ref"],
    ["a heuristic row naming a missing macro", heuristicProfile({ structure: { ...heuristic, fallback: "scqa-c4" } }), "dangling-ref"],
    ["a fixed macro with no registered structure", fixedProfile({ structure: { order: "fixed", macro: "freytag", blocks: [{ id: "a", goal: "g", seconds: [1, 2], beats: ["hook"] }], systems: [] } }), "unknown-structure"],
    ["a heuristic macro with no registered structure", heuristicProfile({ structure: { ...heuristic, macros: { ...heuristic.macros, freytag: ["setup"] }, fallback: "freytag" } }), "unknown-structure"],
    ["a target above the max", fixedProfile({ runtime: { targetS: 800, minS: 480, maxS: 720, splitAboveS: 900 } }), "runtime-order"],
    ["a field both repeated and varied", fixedProfile({ series: { mayRepeat: ["hook-kind"], mustVary: fixedProfile().series.mustVary } }), "series-overlap"],
    ["mustVary without the style pack", fixedProfile({ series: { mayRepeat: [], mustVary: ["hook-kind", "close-kind", "function-mix", "component-histogram"] } }), "series-base-missing"],
    ["a fixed order that must vary its chapter labels", fixedProfile({ series: { mayRepeat: [], mustVary: [...fixedProfile().series.mustVary, "chapter-labels"] } }), "series-structure-mismatch"],
    ["a heuristic order that lets its structure repeat", heuristicProfile({ series: { mayRepeat: ["structure"], mustVary: fixedProfile().series.mustVary } }), "series-structure-mismatch"],
    ["a publishable audience with no owner ask", fixedProfile({ audience: { default: "owner-internal", allow: ["owner-internal", "public-youtube"], kind: "assigned" } }), "publish-unguarded"],
    ["a beat system with no file", bound({ system: "ghost", macro: "scqa-c4" }), "unknown-beat-system"],
    ["a beat system bound to a macro the profile never plays", bound({ system: "hook-close", macro: "abt" }), "dangling-ref"],
    ["a beat system scoped to a block outside its macro", bound({ system: "hook-close", macro: "scqa-c4", blocks: ["ghost"] }), "dangling-ref"],
    ["a required step no block allows", bound({ system: "walk-first", macro: "scqa-c4" }), "beat-system-order"],
    ["a required step that only an earlier block allows", bound({ system: "walk-first", macro: "scqa-c4" }, [blockOf("open", "hook"), blockOf("walk", "code-walk")]), "beat-system-order"],
    ["an allowed style pack with no file", fixedProfile({ styles: { allow: ["plain", "loud"] } }), "unknown-style-pack"],
    ["a house pack outside styles.allow", fixedProfile({ styles: { allow: ["plain", "bold"], house: "loud" } }), "unknown-style-pack"],
    ["one allowed pack where the series must vary it", fixedProfile({ styles: { allow: ["plain"] } }), "style-pack-unvaried"],
    ["a voice speech-tts Kokoro does not offer", fixedProfile({ voice: { id: "bf_emma", rate: 1 } }), "unknown-voice"],
    ["a paper profile without the re-plot check", fixedProfile({ family: "review-paper", publish: { ownerAskPerVideo: true, checks: ["quotes-short"] } }), "publish-unguarded"],
  ])("reports %s", (_name, profile, code) => {
    expect(codes(profile)).toEqual([code]);
  });

  it("reports a second profile that takes the first one's voice band, and not one that changes its rate", () => {
    const tour = fixedProfile();

    expect(codes(tour, heuristicProfile({ voice: tour.voice }))).toEqual(["voice-shared"]);
    expect(codes(tour, heuristicProfile({ voice: { ...tour.voice, rate: 1.1 } }))).toEqual([]);
  });

  it("finds nothing in a beat system whose steps land in order, optional ones dropped or scoped to one block", () => {
    const walkThenClose = [blockOf("open", "hook"), blockOf("walk", "code-walk", "hook")];

    expect(codes(bound({ system: "hook-close", macro: "scqa-c4" }))).toEqual([]);
    expect(codes(bound({ system: "walk-first", macro: "scqa-c4", blocks: ["walk"] }, walkThenClose))).toEqual([]);
  });

  it("finds nothing in the shipped profiles against the shipped vocabulary", () => {
    expect(checkProfiles(loadProfiles(), loadDoctrine().vocabulary)).toEqual([]);
  });
});
