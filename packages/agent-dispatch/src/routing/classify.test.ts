import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyTask, profileFor, unitsOf, type TaskFacts } from "./classify.js";
import { DEFAULT_WORKFLOW_TABLE } from "./node.js";
import { parseWorkflowTable } from "./table.js";

const table = parseWorkflowTable(fs.readFileSync(DEFAULT_WORKFLOW_TABLE, "utf8")).table!;

const facts = (over: Partial<TaskFacts>): TaskFacts => ({
  estimate: 2,
  done_when: "ships",
  tags: [],
  owns: ["src/cli/x.ts"],
  ...over,
});
const priorOf = (over: Partial<TaskFacts>) => classifyTask(table, facts(over)).prior;

describe("the task-time prior, one case per row in order", () => {
  it.each([
    ["door owns", { owns: [".github/workflows/ci.yml"] }, "one-way"],
    ["the one-way tag", { tags: ["one-way"] }, "one-way"],
    ["safety owns", { owns: ["src/broker/core.ts"] }, "safety-path"],
    ["kind:security with no owns", { tags: ["kind:security"], owns: [] }, "safety-path"],
    ["visual owns", { owns: ["src/dashboard/styles.css"] }, "ui-round"],
    ["owns across two units", { owns: ["src/cli/x.ts", "src/agents/y.ts"] }, "cross-package"],
    ["agent-text-only owns", { owns: ["plugins/agent-chat/skills/a/SKILL.md", "CLAUDE.md"] }, "agent-text"],
    ["estimate 1 kind:docs", { estimate: 1, tags: ["kind:docs"] }, "small"],
    ["estimate 2", { estimate: 2 }, "standard"],
    ["estimate 3", { estimate: 3 }, "needs-plan"],
    ["no estimate", { estimate: null }, "needs-plan"],
    ["no done_when", { estimate: 1, done_when: null }, "needs-plan"],
  ] as const)("%s is %s", (_case, over, prior) => {
    expect(priorOf(over)).toBe(prior);
  });

  it("puts risk before size: estimate 1 with safety owns is safety-path", () => {
    expect(priorOf({ estimate: 1, tags: ["kind:docs"], owns: ["src/leak-guard/scan.ts"] })).toBe("safety-path");
  });

  it("names the owned path and list that matched", () => {
    expect(classifyTask(table, facts({ owns: ["src/broker/"] }))).toEqual({
      prior: "safety-path",
      reason: "owns src/broker/ matches safety",
    });
  });
});

describe("a task whose files are unknown", () => {
  it("does not route down to standard at estimate 2 with a done_when", () => {
    expect(priorOf({ estimate: 2, owns: [] })).toBe("needs-plan");
  });

  it("does not route down to small at estimate 1 with kind:docs", () => {
    expect(priorOf({ estimate: 1, tags: ["kind:docs"], owns: [] })).toBe("needs-plan");
  });
});

describe("units for cross-package", () => {
  it("does not count a test path or a .changeset/ path as a unit", () => {
    const owns = ["src/cli/x.ts", "src/__tests__/x.test.ts", ".changeset/a.md", "src/agents/x.spec.ts"];

    expect(unitsOf(owns)).toEqual(["src/cli"]);
    expect(priorOf({ owns })).toBe("standard");
  });

  it("counts packages, products, apps and plugins by their first directory", () => {
    expect(unitsOf(["packages/a/src/x.ts", "packages/a/y.ts", "apps/b/z.ts", "README.md"])).toEqual([
      "packages/a",
      "apps/b",
    ]);
  });
});

describe("the profile a prior dispatches", () => {
  it.each([
    ["standard", 2, "bd-implementer-lite"],
    ["small", 1, "bd-implementer-lite"],
    ["safety-path", 1, "bd-implementer"],
    ["agent-text", 1, "bd-implementer"],
    ["needs-plan", 5, "bd-planner"],
    ["needs-plan", null, "bd-planner"],
  ] as const)("%s at estimate %s is %s", (prior, estimate, profile) => {
    expect(profileFor(table, prior, estimate)).toBe(profile);
  });
});
