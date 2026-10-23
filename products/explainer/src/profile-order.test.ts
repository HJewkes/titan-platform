import { describe, expect, it } from "vitest";
import { heuristicProfile } from "./profile-fixtures.test-helpers.js";
import { loadProfiles, profileFor } from "./profile-load.js";
import { chapterOrder } from "./profile-order.js";

const shipped = loadProfiles();
const tour = profileFor(shipped, "repo-tour");
const argument = profileFor(shipped, "repo-argument");

const TOUR_ORDER = ["cold-open", "purpose", "entry-points", "architecture", "request-walk", "features", "worth-knowing", "health", "scorecard", "read-first"];

describe("chapterOrder: the tour", () => {
  it.each([
    ["no signals", []],
    ["a decision", ["deciding"]],
    ["an anomaly", ["anomaly"]],
    ["every signal", ["deciding", "anomaly", "central-problem", "elegant-idea", "parallel-findings"]],
  ])("gives the fixed C4 chapter order for %s", (_name, signals) => {
    expect(chapterOrder(tour, { signals: new Set(signals) })).toEqual({ macro: "scqa-c4", blocks: TOUR_ORDER });
  });
});

describe("chapterOrder: the argument follows the story-structure heuristic", () => {
  it.each<[string, string[], number | undefined, string, string | undefined]>([
    ["a decision beats every later row", ["deciding", "anomaly", "elegant-idea"], undefined, "scqa", "deciding"],
    ["an anomaly with no decision", ["anomaly", "parallel-findings"], undefined, "mystery", "anomaly"],
    ["a central problem at five minutes", ["central-problem"], 300, "three-act", "central-problem"],
    ["a central problem under five minutes", ["central-problem"], 240, "abt", "central-problem"],
    ["an elegant idea", ["elegant-idea"], undefined, "kishotenketsu", "elegant-idea"],
    ["parallel findings", ["parallel-findings"], undefined, "countdown", "parallel-findings"],
    ["no signal", [], undefined, "abt", undefined],
    ["an unknown signal", ["onboarding"], undefined, "abt", undefined],
  ])("picks the macro for %s", (_name, signals, runtimeS, macro, signal) => {
    const order = chapterOrder(argument, { signals: new Set(signals), ...(runtimeS === undefined ? {} : { runtimeS }) });

    expect(order.macro).toBe(macro);
    expect(order.signal).toBe(signal);
    expect(order.blocks).toEqual(argument.structure.order === "heuristic" ? argument.structure.macros[macro] : []);
  });

  it("orders blocks by the picked macro, so different material gives a different order", () => {
    const profile = heuristicProfile();

    expect(chapterOrder(profile, { signals: new Set(["deciding"]) }).blocks).toEqual(["setup", "answer", "close"]);
    expect(chapterOrder(profile, { signals: new Set(["anomaly"]) }).blocks).toEqual(["anomaly", "reveal", "close"]);
  });

  it("reads the profile's target runtime when the material states none", () => {
    const longTarget = heuristicProfile({ runtime: { targetS: 330, minS: 210, maxS: 360, splitAboveS: 400 } });

    expect(chapterOrder(longTarget, { signals: new Set(["problem"]) }).macro).toBe("three-act");
    expect(chapterOrder(heuristicProfile(), { signals: new Set(["problem"]) }).macro).toBe("abt");
  });
});
