import { describe, expect, it } from "vitest";
import { PlanBindings } from "./round-plan-binding.js";

const TASK_SCOPE = { doneWhenHash: "0123abcd", reason: "one-way-door", visualSignoff: false };
const taskBinding = (extra: Record<string, unknown> = {}) => ({ questionId: "q1", approve: "Approve: validate example/TP-1", task: "example/TP-1", repo: "example-org/example-repo", gate: "task", scope: TASK_SCOPE, ...extra });

describe("a plan round's task binding", () => {
  it("a task binding parses; a task binding with path scope is refused", () => {
    expect(PlanBindings.safeParse([taskBinding()]).success).toBe(true);
    expect(PlanBindings.safeParse([taskBinding({ scope: { paths: ["src/x.ts"] } })]).success).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a reason outside the four", { scope: { ...TASK_SCOPE, reason: "nice-to-have" } }],
    ["a done_when hash that is not 8 hex", { scope: { ...TASK_SCOPE, doneWhenHash: "xyz" } }],
    ["a bare task id", { task: "TP-1" }],
    ["a lower-case task id", { task: "example/tp-1" }],
  ])("a task binding with %s is refused", (_case, extra) => {
    expect(PlanBindings.safeParse([taskBinding(extra)]).success).toBe(false);
  });
});
