import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { BeatSystemError, beatSystemFor, loadBeatSystems, UnknownBeatSystemError } from "./beat-system-load.js";
import { placeBeatSystem } from "./beat-system-schema.js";
import { writeDoctrineDir } from "./doctrine-fixtures.test-helpers.js";
import { BEAT_SYSTEMS, beatSystem } from "./profile-fixtures.test-helpers.js";
import { loadProfiles } from "./profile-load.js";

const PLAN_SYSTEMS = ["bluf", "cl-order", "example-first", "martini-glass", "journey-of-attempts", "chapter-question", "countdown-rung", "lab-cycle", "board-walk"];

/** A doctrine dir over the fixture vocabulary (beat systems walk-first and hook-close) holding `systems`. */
function writeSystems(systems: Record<string, unknown>): string {
  const dir = writeDoctrineDir({});
  mkdirSync(join(dir, "beat-systems"));
  for (const [name, body] of Object.entries(systems)) writeFileSync(join(dir, "beat-systems", name), stringify(body));
  return dir;
}

const soundPair = { "walk-first.yaml": beatSystem("walk-first"), "hook-close.yaml": beatSystem("hook-close") };

describe("loadBeatSystems", () => {
  it("loads the nine plan systems, and nothing from the unverified Xu and Wei patterns", () => {
    const systems = loadBeatSystems();

    expect([...systems.keys()].sort()).toEqual([...PLAN_SYSTEMS].sort());
    expect([...systems.values()].filter(({ id, source }) => /xu|wei|W4[89]|W50/i.test(`${id} ${source}`))).toEqual([]);
  });

  it("loads a sound registry over its own dir's vocabulary", () => {
    expect([...loadBeatSystems(writeSystems(soundPair)).keys()]).toEqual(["hook-close", "walk-first"]);
  });

  it.each([
    ["a system the vocabulary does not name", { ...soundPair, "freytag.yaml": beatSystem("freytag") }, /beat system freytag is not in vocabulary\.yaml/],
    ["a step beat outside the vocabulary", { ...soundPair, "hook-close.yaml": beatSystem("hook-close", { steps: [{ beats: ["hook"], does: "Open." }, { beats: ["verdict-card"], does: "Close." }] }) }, /hook-close plays beat verdict-card, which is not in vocabulary\.yaml/],
    ["a vocabulary system with no file", { "walk-first.yaml": beatSystem("walk-first") }, /names hook-close, which has no beat-systems\/hook-close\.yaml/],
  ])("rejects %s", (_name, files, message) => {
    const dir = writeSystems(files);

    expect(() => loadBeatSystems(dir)).toThrow(BeatSystemError);
    expect(() => loadBeatSystems(dir)).toThrow(message);
  });

  it("rejects a shape error, naming the file", () => {
    const dir = writeSystems({ ...soundPair, "hook-close.yaml": beatSystem("hook-close", { steps: [{ beats: ["hook"], does: "Only." }] }) });

    expect(() => loadBeatSystems(dir)).toThrow(/beat-systems\/hook-close\.yaml: .*steps/s);
  });
});

describe("beatSystemFor", () => {
  it("rejects an unknown beat system, naming the known ones", () => {
    expect(() => beatSystemFor(loadBeatSystems(), "xu-opening")).toThrow(UnknownBeatSystemError);
    expect(() => beatSystemFor(loadBeatSystems(), "xu-opening")).toThrow(/known: .*cl-order/);
  });
});

describe("placeBeatSystem", () => {
  it("lands each step in the earliest block at or after the step before, and drops an optional step no block allows", () => {
    const blocks = [
      { id: "open", beats: ["hook"] },
      { id: "close", beats: ["hook"] },
    ];

    expect(placeBeatSystem(BEAT_SYSTEMS.get("hook-close")!, blocks)).toEqual({ placed: [{ step: 0, block: "open" }, { step: 2, block: "open" }], unplaced: [] });
  });

  it("reports a required step that only an earlier block allows", () => {
    const blocks = [
      { id: "open", beats: ["hook"] },
      { id: "walk", beats: ["code-walk"] },
    ];

    expect(placeBeatSystem(BEAT_SYSTEMS.get("walk-first")!, blocks).unplaced).toEqual([1]);
  });
});

describe("the shipped bindings", () => {
  const { profiles } = loadProfiles();
  const bound = (type: string) => profiles.get(type)?.structure.systems ?? [];

  it("bind every plan system to some profile and structure", () => {
    const used = new Set([...profiles.values()].flatMap((profile) => profile.structure.systems.map((binding) => binding.system)));

    expect(PLAN_SYSTEMS.filter((id) => !used.has(id))).toEqual([]);
  });

  it("leave the daily more than one beat order to audition, not one BLUF template (owner Q2 B)", () => {
    expect(new Set(bound("daily-overview").map((binding) => binding.system)).size).toBeGreaterThan(1);
  });

  it("give the tour more than one beat system inside its fixed chapters", () => {
    expect(bound("repo-tour").filter((binding) => binding.blocks?.includes("features")).map((binding) => binding.system)).toEqual(["chapter-question", "lab-cycle"]);
  });
});
