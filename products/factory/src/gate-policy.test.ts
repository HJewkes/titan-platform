import { describe, expect, it } from "vitest";
import { gateEverything, policyTraceGate } from "./gate-policy.js";

describe("gateEverything", () => {
  it.each(["publish", "merge", "actuate-device", "anything-new"])("sends %s to a human", (action) => {
    expect(gateEverything.decide(action)).toMatchObject({ outcome: "gate", rule: { table: "factory-default", rowId: "gate-all", version: 1 } });
  });

  it("records a decision as a policy trace gate keyed under the step attempt", () => {
    const gate = policyTraceGate(gateEverything.decide("merge"), { traceId: "r", spanId: "workflow:r:merge:0:0" });

    expect(gate).toMatchObject({
      id: "workflow:r:merge:0:0#policy:factory-default:gate-all",
      gateKind: "policy",
      verdict: null,
      decidedBy: "policy:factory-default",
    });
  });
});
