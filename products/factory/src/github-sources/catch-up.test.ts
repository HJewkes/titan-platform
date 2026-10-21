import { describe, expect, it } from "vitest";
import { resolveSources, type SourcesReader } from "./mode.js";
import { startReconcilerSchedule } from "./schedule.js";
import { PRIOR_RULESETS, SCENARIO_DELIVERIES, SCENARIO_RULESETS, deliver, priorSnapshot, scenarioReconciler, scenarioSnapshot } from "./scenario.test-helpers.js";

describe("catch-up pass after a kill-switch flip (TP-3099 I6)", () => {
  it("inserts nothing over transitions and occurrences the webhook rows already logged", async () => {
    const state = { snapshot: priorSnapshot(), rulesets: PRIOR_RULESETS };
    const reconciler = scenarioReconciler(state);
    let ingress: "on" | "off" = "on";
    const sources: SourcesReader = () => resolveSources({ github: { sources: "webhook", ingress } });
    const schedule = startReconcilerSchedule({ sources, pass: (signal) => reconciler.service.tick(signal), now: reconciler.clock.now, log: reconciler.log });
    await schedule.tick();
    const afterStart = reconciler.rows();
    Object.assign(state, { snapshot: scenarioSnapshot(), rulesets: SCENARIO_RULESETS });
    deliver(reconciler.db, SCENARIO_DELIVERIES);
    const afterWebhook = reconciler.rows();
    const linesBefore = reconciler.lines.length;

    ingress = "off";
    await schedule.tick();
    schedule.halt();

    const catchUp = reconciler.lines.slice(linesBefore);
    expect(reconciler.github.count("snapshot")).toBe(2);
    expect(afterWebhook).toBeGreaterThan(afterStart);
    expect(reconciler.rows()).toBe(afterWebhook);
    expect(catchUp.filter((line) => line.msg === "reconciler.filled")).toEqual([]);
    const confirmed = catchUp.filter((line) => line.msg === "reconciler.confirmed").map((line) => line.fields.by);
    expect(confirmed.length).toBe(SCENARIO_DELIVERIES.length);
    expect(new Set(confirmed)).toEqual(new Set(["occurrence", "unchanged"]));
  });
});
