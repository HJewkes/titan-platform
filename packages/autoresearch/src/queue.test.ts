import { describe, expect, it } from "vitest";
import { applyOps, quotaRules, quotaViolations, toIdea } from "./queue.js";
import { QueueOpsSchema, type QueueOps } from "./schemas.js";
import { FIXTURE_BOUNDS, proposal } from "./test-support/fake-ports.js";

const ops = (input: Partial<QueueOps>): QueueOps => QueueOpsSchema.parse(input);
const QUOTA = { keptLastRound: [] as string[], minPool: 0, queuedBefore: 0 };
const CONTEXT = { round: 2, bounds: FIXTURE_BOUNDS, caseNames: ["t-alpha"], deadEnds: [], seen: new Set<string>(), lineageOf: new Map<string, string>() };

describe("planner quotas", () => {
  it("refuses a round with no bold idea unless the planner states an exemption", () => {
    expect(quotaViolations(ops({ add: [proposal("a")] }), QUOTA)).toEqual(["no bold idea and no [EXEMPT] reason"]);
    expect(quotaViolations(ops({ add: [proposal("a")], exempt: { bold: "pool is all bold" } }), QUOTA)).toEqual([]);
  });

  it("refuses a round after a keep with no follow-up on the kept idea", () => {
    const quota = { ...QUOTA, keptLastRound: ["i-kept"] };
    const followup = proposal("why", { bold: true, source: "followup", parent: "i-kept" });

    expect(quotaViolations(ops({ add: [proposal("a", { bold: true })] }), quota)).toEqual(["no follow-up for kept idea i-kept"]);
    expect(quotaViolations(ops({ add: [followup] }), quota)).toEqual([]);
  });

  it("refuses a candidate pool under the minimum", () => {
    expect(quotaViolations(ops({ add: [proposal("a", { bold: true })] }), { ...QUOTA, minPool: 12, queuedBefore: 10 })).toEqual(["candidate pool 11 is under 12"]);
  });
});

describe("the quota rules a planner is told", () => {
  const quota = { keptLastRound: ["i-kept"], minPool: 9, queuedBefore: 6 };

  it("state the minimum pool, the net adds it takes and the kept ideas owing a follow-up", () => {
    const rules = quotaRules(quota).join("\n");

    expect(rules).toContain("at least 9");
    expect(rules).toContain("the queue holds 6, so adds minus drops must be at least 3");
    expect(rules).toContain("i-kept");
  });

  it("name exactly the net adds the pool check accepts", () => {
    const followup = proposal("f", { bold: true, source: "followup", parent: "i-kept" });
    const adds = (count: number) => [followup, ...["a", "b", "c"].slice(0, count - 1).map((name) => proposal(name))];

    expect(quotaViolations(ops({ add: adds(3) }), quota)).toEqual([]);
    expect(quotaViolations(ops({ add: adds(2) }), quota)).toEqual(["candidate pool 8 is under 9"]);
  });
});

describe("applying queue ops", () => {
  it("rejects an exact repeat, an out-of-bounds target and a case name before any spawn", () => {
    const seen = toIdea(proposal("seen"), CONTEXT);
    const applied = applyOps([], ops({ add: [proposal("seen"), proposal("far", { targets: ["src/other.py"] }), proposal("names t-alpha"), proposal("fine")] }), { ...CONTEXT, seen: new Set([seen.id]) });

    expect(applied.rejected.map((entry) => entry.code)).toEqual(["rejected:pre:duplicate", "rejected:pre:target-outside-class", "rejected:pre:case-name"]);
    expect(applied.queue.map((idea) => idea.mechanism)).toEqual(["fine"]);
  });

  it("drops an owner idea only with a reason, and a follow-up inherits its parent's lineage", () => {
    const owner = toIdea(proposal("owner", { source: "owner" }), CONTEXT);
    const kept = applyOps([owner], ops({ drop: [{ id: owner.id }] }), CONTEXT);
    const dropped = applyOps([owner], ops({ drop: [{ id: owner.id, reason: "superseded by a bolder idea" }] }), CONTEXT);
    const child = toIdea(proposal("child", { source: "followup", parent: owner.id }), { ...CONTEXT, lineageOf: new Map([[owner.id, "i-root"]]) });

    expect(kept.queue).toHaveLength(1);
    expect(dropped.queue).toHaveLength(0);
    expect(child.lineage).toBe("i-root");
  });

  it("checks params against the class ranges, the exact key ahead of a wildcard", () => {
    const param = (params: Record<string, number>) => proposal(`p-${JSON.stringify(params)}`, { class: "config-param", targets: ["src/config.json"], params });
    const applied = applyOps([], ops({ add: [param({ hot_cc: 20 }), param({ "p5.x": 0.1 }), param({ cold: 1 })] }), CONTEXT);

    expect(applied.rejected.map((entry) => entry.code)).toEqual(["rejected:pre:param-out-of-range", "rejected:pre:param-unknown"]);
  });
});
