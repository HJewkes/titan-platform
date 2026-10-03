import { describe, expect, it } from "vitest";
import { parseRoutingPolicy, setCategoryMode } from "./policy.js";
import { route, type RouteContext, type RouteQuestion } from "./router.js";

const base = parseRoutingPolicy({
  hardStops: ["rotate the signing key"],
  humanOnlyInitiatives: ["family-trip"],
});
const policy = setCategoryMode(setCategoryMode(base, "agent_ops", "auto"), "scope_priority", "off");
const agent: RouteContext = {
  agentId: "implementer-1",
  blocking: "parked",
  otherWork: false,
};
const attendedParked: RouteContext = { blocking: "parked", otherWork: false };

function q(over: Partial<RouteQuestion>): RouteQuestion {
  return {
    category: "agent_ops",
    question: "How many implementers for this wave?",
    options: ["two", "three"],
    ...over,
  };
}

describe("route", () => {
  it.each<[string, RouteQuestion, RouteContext, string, boolean, number]>([
    ["human-only initiative", q({ initiative: "family-trip" }), agent, "owner-queue", false, 1],
    ["taste category", q({ category: "visual_taste", question: "Which variant?" }), agent, "owner-queue", false, 1],
    ["unlock-table category", q({ category: "merge_gate" }), agent, "owner-queue", false, 1],
    ["unlock text in the question", q({ question: "Restart the worker pool?" }), agent, "owner-queue", false, 1],
    ["unlock text in an option", q({ options: ["two", "delete the third"] }), agent, "owner-queue", false, 1],
    [
      "hard stop in the question",
      q({ question: "Should I Rotate the signing key now?" }),
      agent,
      "owner-queue",
      false,
      1,
    ],
    [
      "hard stop while attended and parked",
      q({ question: "Rotate the signing key?" }),
      attendedParked,
      "owner-now",
      false,
      1,
    ],
    ["blocking attended ask", q({ category: "tech_design" }), attendedParked, "owner-now", false, 2],
    ["blocking attended ask in an auto category", q({}), attendedParked, "owner-now", false, 2],
    ["auto-enabled category with options", q({}), agent, "decider", false, 3],
    ["auto category with no options", q({ options: [] }), agent, "owner-queue", false, 4],
    ["shadow category", q({ category: "tech_design" }), agent, "owner-queue", true, 4],
    ["off category", q({ category: "scope_priority" }), agent, "owner-queue", false, 4],
  ])("%s", (_name, question, ctx, expected, shadow, rule) => {
    const decision = route(question, policy, ctx);

    expect(decision).toMatchObject({ route: expected, shadow, rule });
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it.each<[string, RouteContext]>([
    ["an agent session", { agentId: "implementer-1", blocking: "parked" }],
    ["an attended ask with other work", { blocking: "parked", otherWork: true }],
    ["an attended ask that is not parked", { blocking: "none" }],
    ["no context", {}],
  ])("does not interrupt the owner for %s", (_name, ctx) => {
    expect(route(q({ category: "tech_design" }), policy, ctx).route).toBe("owner-queue");
  });

  it("treats an empty agent id as attended", () => {
    expect(route(q({}), policy, { agentId: "", blocking: "parked" }).route).toBe("owner-now");
  });

  it("names the matched unlock row in its reason", () => {
    expect(route(q({ question: "Publish 0.3 to npm?" }), policy, agent).reason).toContain("publish or release");
  });

  it("keeps an always-ask category with the owner even if stored data says auto", () => {
    const stored = parseRoutingPolicy({
      categories: [{ category: "money", mode: "auto" }],
    });

    expect(route(q({ category: "money", question: "Which tier?" }), stored, agent)).toMatchObject({
      route: "owner-queue",
      rule: 1,
    });
  });
});
