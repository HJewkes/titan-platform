import { DEFAULT_TABLE } from "@titan-design/authority";
import type { PolicyTable } from "@titan-design/authority";
import { describe, expect, it } from "vitest";
import { AGENT_CANDIDATES } from "./actor.js";
import type { ActorObservation } from "./actor.js";
import { decide } from "./decide.js";
import { classified } from "./spellings.js";

const agents: ActorObservation = { candidates: AGENT_CANDIDATES, id: "impl-7", bypass: false };
const owner: ActorObservation = { candidates: ["owner-terminal"], id: "sess-1", bypass: true };
const merge = classified("bash.merge.gh-pr-merge", { pr: "12" });

function withVerdicts(changes: Record<string, "allow" | "deny">): PolicyTable {
  const rules = DEFAULT_TABLE.rules.map((r) => (changes[r.id] ? { ...r, verdict: changes[r.id], resolvers: undefined } : r));
  return { ...DEFAULT_TABLE, rules } as PolicyTable;
}

describe("decide", () => {
  it("denies a merge for the agent candidates and names the owner gate", () => {
    const decision = decide([merge], agents);

    expect(decision).toMatchObject({ outcome: "deny", action: "merge", spelling: "bash.merge.gh-pr-merge", subject: { pr: "12" } });
    if (decision.outcome !== "deny") throw new Error("expected a deny");
    expect(decision.reason).toContain("owner-resolved gate (rule MRG-CO)");
    expect(decision.reason).toContain("owner");
    expect(decision.reason).not.toMatch(/\n/);
  });

  it("denies a gate even when it is the strictest verdict", () => {
    const decision = decide([merge], agents, withVerdicts({ "MRG-WK": "allow", "MRG-HD": "allow" }));

    expect(decision).toMatchObject({ outcome: "deny", ruleId: "MRG-CO" });
  });

  it("still denies when a relaxed table allows the coordinator", () => {
    const decision = decide([merge], agents, withVerdicts({ "MRG-CO": "allow" }));

    expect(decision).toMatchObject({ outcome: "deny", ruleId: "MRG-WK" });
  });

  it("passes an empty action list", () => {
    expect(decide([], agents)).toEqual({ outcome: "pass", matched: null });
  });

  it("passes the owner at a terminal and reports the rule that allowed it", () => {
    expect(decide([merge], owner)).toEqual({ outcome: "pass", matched: { ruleId: "MRG-OT", action: "merge", spelling: "bash.merge.gh-pr-merge", subject: { pr: "12" } } });
  });

  it("keeps the strictest action when several classify", () => {
    const read = classified("bash.secret.cat", { pattern: "home:.npmrc" });

    const decision = decide([classified("bash.release.npm-publish", { tool: "npm" }), read], owner, withVerdicts({ "SEC-OT": "deny" }));

    expect(decision).toMatchObject({ outcome: "deny", ruleId: "SEC-OT", spelling: "bash.secret.cat" });
  });
});
