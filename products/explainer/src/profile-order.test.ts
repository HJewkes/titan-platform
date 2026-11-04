import { describe, expect, it } from "vitest";
import { STRUCTURES, heuristicProfile, narrativeStructure } from "./profile-fixtures.test-helpers.js";
import { UnknownStructureError, loadProfiles, profileFor } from "./profile-load.js";
import { chapterOrder } from "./profile-order.js";

const shipped = loadProfiles();
const tour = profileFor(shipped, "repo-tour");
const argument = profileFor(shipped, "repo-argument");

const TOUR_ORDER = ["cold-open", "purpose", "entry-points", "architecture", "request-walk", "features", "worth-knowing", "health", "scorecard", "read-first"];

describe("chapterOrder: the tour", () => {
  it.each([
    ["no signals", []],
    ["a decision", ["decision-pending"]],
    ["an anomaly", ["anomaly"]],
    ["every signal", ["decision-pending", "anomaly", "central-problem", "elegant-idea", "parallel-findings"]],
  ])("gives the fixed C4 chapter order for %s", (_name, signals) => {
    expect(chapterOrder(tour, { signals: new Set(signals) }, shipped.structures)).toEqual({ macro: "scqa-c4", fallback: false, blocks: TOUR_ORDER });
  });
});

describe("chapterOrder: the argument asks the shipped structures' fit predicates", () => {
  it.each<[string, string[], number | undefined, string, boolean]>([
    ["a decision beats every later row", ["decision-pending", "anomaly", "elegant-idea"], undefined, "scqa", false],
    ["an anomaly with no decision", ["anomaly", "parallel-findings"], undefined, "mystery", false],
    ["a central problem at five minutes", ["central-problem"], 300, "three-act", false],
    ["a central problem under five minutes", ["central-problem"], 240, "abt", false],
    ["an elegant idea", ["elegant-idea"], undefined, "kishotenketsu", false],
    ["an elegant idea that solves a problem", ["elegant-idea", "central-problem"], 240, "abt", false],
    ["parallel findings", ["parallel-findings"], undefined, "countdown", false],
    ["no signal", [], undefined, "abt", true],
    ["an unknown signal", ["onboarding"], undefined, "abt", true],
  ])("picks the macro for %s", (_name, signals, runtimeS, macro, fallback) => {
    const order = chapterOrder(argument, { signals: new Set(signals), ...(runtimeS === undefined ? {} : { runtimeS }) }, shipped.structures);

    expect(order.macro).toBe(macro);
    expect(order.fallback).toBe(fallback);
    expect(order.blocks).toEqual(argument.structure.order === "heuristic" ? argument.structure.macros[macro] : []);
  });
});

describe("chapterOrder: the heuristic reads the registry, not the profile", () => {
  it("orders blocks by the picked macro, so different material gives a different order", () => {
    const profile = heuristicProfile();

    expect(chapterOrder(profile, { signals: new Set(["deciding"]) }, STRUCTURES).blocks).toEqual(["setup", "answer", "close"]);
    expect(chapterOrder(profile, { signals: new Set(["anomaly"]) }, STRUCTURES).blocks).toEqual(["anomaly", "reveal", "close"]);
  });

  it("reads the profile's target runtime when the material states none", () => {
    const longTarget = heuristicProfile({ runtime: { targetS: 330, minS: 210, maxS: 360, splitAboveS: 400 } });

    expect(chapterOrder(longTarget, { signals: new Set(["problem"]) }, STRUCTURES).macro).toBe("three-act");
    expect(chapterOrder(heuristicProfile(), { signals: new Set(["problem"]) }, STRUCTURES).macro).toBe("abt");
  });

  it("follows a changed fit predicate in the registry", () => {
    const anomalyDecides = new Map([...STRUCTURES, ["scqa", narrativeStructure("scqa", { any: ["anomaly"] })]]);

    expect(chapterOrder(heuristicProfile(), { signals: new Set(["anomaly"]) }, anomalyDecides).macro).toBe("scqa");
  });

  it("throws on a row whose structure is not registered", () => {
    const withoutScqa = new Map([...STRUCTURES].filter(([id]) => id !== "scqa"));

    expect(() => chapterOrder(heuristicProfile(), { signals: new Set(["deciding"]) }, withoutScqa)).toThrow(UnknownStructureError);
  });
});
