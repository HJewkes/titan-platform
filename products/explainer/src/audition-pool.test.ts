import { describe, expect, it } from "vitest";
import { auditionPool, profileDefault } from "./audition-pool.js";
import { loadDoctrine } from "./doctrine-load.js";
import { buildMaterialMap, type MaterialMap } from "./material-map.js";
import { loadProfiles, profileFor } from "./profile-load.js";

const set = loadProfiles();
const vocabulary = loadDoctrine().vocabulary.signals;

/** Synthetic facts only; each list is shaped to fire the named signals. */
function mapOf(texts: readonly string[], type: string): MaterialMap {
  const facts = texts.map((text, i) => ({ id: `F${i + 1}`, text }));
  return buildMaterialMap({ factsSha: "0".repeat(64), format: "facts-md", facts, profile: profileFor(set, type), structures: set.structures, vocabulary });
}

const poolOf = (texts: readonly string[], type: string) => auditionPool(mapOf(texts, type), profileFor(set, type));
const shape = (pool: ReturnType<typeof auditionPool>) => pool.slots.map((s) => `${s.structure}/${s.system ?? "-"}/${s.basis}`);

const DECISION = "The owner should adopt the new cache.";
const PAIN = "Builds are slow on every laptop.";
const ANOMALY = "The counter silently drops every tenth event.";
const LINTS = ["One lint flags long labels.", "One lint flags dark text.", "One lint flags clipped arrows."];

describe("audition pool", () => {
  it("three candidates are three slots under different structures, in the profile's heuristic order", () => {
    const pool = poolOf([DECISION, PAIN, ...LINTS], "repo-argument");

    expect(shape(pool)).toEqual(["scqa/-/fits", "abt/-/fits", "countdown/countdown-rung/fits"]);
    expect(pool.fallback).toBeNull();
  });

  it("0 candidates fall back to the fixed macro, each slot under a different bound beat system, and record why", () => {
    const pool = poolOf([DECISION, PAIN, ...LINTS], "repo-tour");

    expect(shape(pool)).toEqual(["scqa-c4/martini-glass/fallback", "scqa-c4/chapter-question/fallback", "scqa-c4/lab-cycle/fallback"]);
    expect(pool.fallback?.structure).toBe("scqa-c4");
    expect(pool.fallback?.reason).toMatch(/^0 candidates: scqa-c4 does not fit; fit but not allowed: abt, countdown, scqa, three-act$/);
  });

  it("a heuristic profile with 0 candidates falls back to its fallback macro", () => {
    expect(profileDefault(profileFor(set, "repo-argument"))).toBe("abt");
    expect(poolOf(["The service keeps records in a table."], "repo-argument").fallback?.structure).toBe("abt");
  });

  it("an undecided structure tops a short pool up to k, after the fitting one, and is marked as such", () => {
    const pool = poolOf([ANOMALY], "repo-argument");

    expect(shape(pool)).toEqual(["mystery/-/fits", "kishotenketsu/-/undecided", "mystery/-/fits"]);
    expect(pool.undecided).toEqual([{ structure: "kishotenketsu", gaps: ["elegant-idea"], used: true }]);
  });

  it("an undecided structure is left out when k structures already fit", () => {
    const pool = poolOf([DECISION, ANOMALY, ...LINTS], "repo-argument");

    expect(shape(pool)).toEqual(["scqa/-/fits", "mystery/-/fits", "countdown/countdown-rung/fits"]);
    expect(pool.undecided).toEqual([{ structure: "kishotenketsu", gaps: ["elegant-idea"], used: false }]);
  });

  it("an undecided structure never counts as a candidate: alone it still leaves the fallback leading", () => {
    const pool = poolOf(["The service keeps records in a table."], "repo-argument");

    expect(shape(pool)).toEqual(["abt/-/fallback", "kishotenketsu/-/undecided", "abt/-/fallback"]);
    expect(pool.fallback?.reason).toContain("kishotenketsu is undecided");
  });
});
