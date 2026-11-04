import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { TaskFacts } from "./classify.js";
import { DEFAULT_WORKFLOW_TABLE } from "./node.js";
import { planFacts, priorRoute, type PriorRouter } from "./prior.js";
import { parseWorkflowTable } from "./table.js";

const TABLE_TEXT = fs.readFileSync(DEFAULT_WORKFLOW_TABLE, "utf8");
const table = parseWorkflowTable(TABLE_TEXT).table!;
const on: PriorRouter = { mode: "on", table };
const LABEL = "example EX-1 (seat core-seat)";

const facts = (over: Partial<TaskFacts>): TaskFacts => ({
  estimate: 2,
  done_when: "ships",
  tags: [],
  owns: ["src/cli/x.ts"],
  ...over,
});

describe("priorRoute", () => {
  it("routes a kind:security estimate-1 task up to bd-implementer with a route-change note", () => {
    const routed = priorRoute(on, facts({ estimate: 1, tags: ["kind:security"] }), "bd-implementer-lite", LABEL);

    expect(routed.profile).toBe("bd-implementer");
    expect(routed.note).toMatch(/^route-change example EX-1 \(seat core-seat\): bd-implementer-lite -> bd-implementer/);
    expect(routed.note).toContain("prior safety-path");
  });

  it("routes a kind:feature estimate-2 task with a done_when down to bd-implementer-lite (prior standard)", () => {
    const routed = priorRoute(on, facts({ estimate: 2, tags: ["kind:feature"] }), "bd-implementer", LABEL);

    expect(routed.profile).toBe("bd-implementer-lite");
    expect(routed.note).toContain("prior standard");
  });

  it("in shadow mode keeps today and notes what on would route", () => {
    const routed = priorRoute({ mode: "shadow", table }, facts({ estimate: 2 }), "bd-implementer", LABEL);

    expect(routed.profile).toBe("bd-implementer");
    expect(routed.note).toMatch(/^would-route .*: bd-implementer -> bd-implementer-lite/);
  });

  it("adds no note when the prior gives the profile today already gives", () => {
    expect(priorRoute(on, facts({ estimate: 2 }), "bd-implementer-lite", LABEL)).toEqual({
      profile: "bd-implementer-lite",
    });
  });

  it("keeps today when the prior names a profile the dispatcher cannot spawn as an implementer", () => {
    const codeTable = parseWorkflowTable(TABLE_TEXT.replace("standard: local-fix", "standard: generated")).table!;

    expect(priorRoute({ mode: "on", table: codeTable }, facts({ estimate: 2 }), "bd-implementer", LABEL)).toEqual({
      profile: "bd-implementer",
    });
  });

  it("keeps bd-implementer for an estimate-2 task with no owns", () => {
    expect(priorRoute(on, facts({ estimate: 2, owns: [] }), "bd-implementer", LABEL)).toEqual({
      profile: "bd-implementer",
    });
  });
});

const PLAN = [
  "# plan",
  "```burndown-slices",
  JSON.stringify([
    { n: "a", title: "one", doneWhen: "x ships", points: 1, dependsOn: [], owns: ["src/agents/x.ts", "src/agents/y.ts"] },
    { n: "b", title: "two", doneWhen: "y ships", points: 2, dependsOn: ["a"], owns: ["src/agents/y.ts", "src/cli/z.ts"] },
  ]),
  "```",
  "",
].join("\n");

describe("planFacts", () => {
  it("gives the union of every slice owns for a task row", () => {
    expect(planFacts(PLAN)).toEqual({ owns: ["src/agents/x.ts", "src/agents/y.ts", "src/cli/z.ts"] });
  });

  it("gives the named slice its own owns and points", () => {
    expect(planFacts(PLAN, "b")).toEqual({ owns: ["src/agents/y.ts", "src/cli/z.ts"], points: 2 });
  });

  it("gives no owns without a plan, with no slices block, or with a block that is not JSON", () => {
    expect(planFacts(undefined)).toEqual({ owns: [] });
    expect(planFacts("# no block", "a")).toEqual({ owns: [] });
    expect(planFacts("```burndown-slices\n[oops\n```\n")).toEqual({ owns: [] });
  });
});
