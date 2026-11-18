import { describe, expect, it } from "vitest";
import { admitLane, DEFAULT_LIMITS, type LaneSignals } from "./back-pressure.js";
import { laneComponents } from "./lane-components.js";

const calm: LaneSignals = { openPrs: 0, mergedNotDeployed: 0, ownerQueue: 0, reviewers: { accounts: 2, exhausted: 0 }, deployStall: [], redMain: [], unread: {} };

const stalled = (counts: { deployCauses?: number; redMainRepos?: number; unreadComponents?: number }) =>
  expect.objectContaining({ code: "dependency-stalled", scope: "lane", numbers: { deployCauses: 0, redMainRepos: 0, unreadComponents: 0, ...counts } });

describe("mapped lane admission", () => {
  it("admits a lane through a stall in a component it does not name", () => {
    const admission = admitLane({ ...calm, deployStall: ["2 refusals in a row"], redMain: ["octo/other"] }, DEFAULT_LIMITS, ["main:octo/demo"]);

    expect(admission).toEqual({ decision: "admit", holds: [] });
  });

  it("holds a lane on a red main in a repo it names, whatever the case of the slug", () => {
    const admission = admitLane({ ...calm, redMain: ["octo/other", "Octo/Demo"] }, DEFAULT_LIMITS, ["main:octo/demo"]);

    expect(admission.decision).toBe("hold");
    expect(admission.holds).toEqual([stalled({ redMainRepos: 1 })]);
  });

  it("holds a lane that names the factory deploy on a deploy alarm", () => {
    const admission = admitLane({ ...calm, deployStall: ["a deploy asked for 70 min ago has not landed"] }, DEFAULT_LIMITS, ["factory-deploy", "main:octo/demo"]);

    expect(admission.holds).toEqual([stalled({ deployCauses: 1 })]);
  });

  it("holds a lane with no mapping on a stall in any component", () => {
    expect(admitLane({ ...calm, redMain: ["octo/other"] }, DEFAULT_LIMITS, undefined).holds).toEqual([stalled({ redMainRepos: 1 })]);
    expect(admitLane({ ...calm, deployStall: ["2 refusals in a row"] }, DEFAULT_LIMITS, undefined).holds).toEqual([stalled({ deployCauses: 1 })]);
  });

  it("counts a named component whose health is unread as stalled", () => {
    const deploy = admitLane({ ...calm, deployStall: undefined, unread: { deploy: "serve down" } }, DEFAULT_LIMITS, ["factory-deploy"]);
    const main = admitLane({ ...calm, redMain: undefined, unread: { redMain: "database locked" } }, DEFAULT_LIMITS, ["main:octo/demo"]);

    expect(deploy.holds).toEqual([stalled({ unreadComponents: 1 }), expect.objectContaining({ code: "signal-unreadable" })]);
    expect(main.holds).toEqual([stalled({ unreadComponents: 1 }), expect.objectContaining({ code: "signal-unreadable" })]);
  });

  it("leaves an unread component it does not name to the unchanged signal-unreadable hold", () => {
    const admission = admitLane({ ...calm, deployStall: undefined, unread: { deploy: "serve down" } }, DEFAULT_LIMITS, ["main:octo/demo"]);

    expect(admission.holds.map((hold) => hold.code)).toEqual(["signal-unreadable"]);
  });
});

describe("lane component lookup", () => {
  const table = [
    { initiative: "alpha", tag: "console", components: ["main:octo/demo"] as const, why: "synthetic" },
    { initiative: "alpha", tag: null, components: ["factory-deploy"] as const, why: "synthetic" },
  ];

  it("finds a lane by initiative and tag, and the untagged lane only without a tag", () => {
    expect(laneComponents({ initiative: "alpha", tag: "console" }, table)).toEqual(["main:octo/demo"]);
    expect(laneComponents({ initiative: "alpha" }, table)).toEqual(["factory-deploy"]);
  });

  it("leaves a lane with no entry unmapped", () => {
    expect(laneComponents({ initiative: "alpha", tag: "other" }, table)).toBeUndefined();
    expect(laneComponents({ initiative: "beta", tag: "console" }, table)).toBeUndefined();
  });
});
