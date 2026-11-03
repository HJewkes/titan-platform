import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { TaskFacts } from "./classify.js";
import { DEFAULT_WORKFLOW_TABLE } from "./node.js";
import { implementerFamily, inFamily, routeSpawn, type RouteInput, type RouteTable } from "./route.js";
import { parseWorkflowTable } from "./table.js";

const TABLE_TEXT = fs.readFileSync(DEFAULT_WORKFLOW_TABLE, "utf8");
const live: RouteTable = { table: parseWorkflowTable(TABLE_TEXT).table!, id: "shape-v1@aaaa1111" };

const standardFacts: TaskFacts = { estimate: 2, done_when: "ships", tags: [], owns: ["src/x/a.ts"] };

const input = (over: Partial<RouteInput>): RouteInput => ({
  mode: "on",
  requested: "bd-implementer",
  table: live,
  taskId: "EX-1",
  facts: standardFacts,
  ...over,
});

describe("routeSpawn, the seven spawn cases", () => {
  it("routes an estimate-2 task with owns down to bd-implementer-lite when on", () => {
    const decision = routeSpawn(input({}));

    expect(decision).toMatchObject({
      profile: "bd-implementer-lite",
      source: "routed",
      prior: "standard",
      wanted: "bd-implementer-lite",
      workflow: "local-fix",
      table: "shape-v1@aaaa1111",
    });
    expect(decision?.note).toBe("route-change EX-1: bd-implementer -> bd-implementer-lite (prior standard: estimate 2 <= 2)");
  });

  it("keeps the requested profile in shadow and records what on would pick", () => {
    expect(routeSpawn(input({ mode: "shadow" }))).toMatchObject({
      profile: "bd-implementer",
      source: "shadow",
      wanted: "bd-implementer-lite",
      note: expect.stringMatching(/^would-route EX-1: bd-implementer -> bd-implementer-lite/),
    });
  });

  it("keeps the caller's family: implementer becomes implementer-lite", () => {
    expect(routeSpawn(input({ requested: "implementer" }))).toMatchObject({
      profile: "implementer-lite",
      source: "routed",
    });
  });

  it("keeps the requested profile on an override and logs it", () => {
    expect(routeSpawn(input({ override: "owner pinned full tier" }))).toMatchObject({
      profile: "bd-implementer",
      source: "override",
      reason: "override owner pinned full tier",
    });
  });

  it("keeps a fix round on the profile it asked for", () => {
    const decision = routeSpawn(input({ role: "fix-round-1" }));

    expect(decision).toMatchObject({ profile: "bd-implementer", source: "keep-role" });
    expect(decision?.wanted).toBeUndefined();
  });

  it("runs auto with no task as bd-implementer", () => {
    expect(routeSpawn(input({ requested: "auto", taskId: undefined }))).toMatchObject({
      profile: "bd-implementer",
      source: "no-task",
    });
  });

  it("gives no decision for a reviewer", () => {
    expect(routeSpawn(input({ requested: "bd-reviewer" }))).toBeUndefined();
  });
});

describe("routeSpawn around the edges", () => {
  it("reads nothing for an explicit profile when off", () => {
    expect(routeSpawn(input({ mode: "off" }))).toBeUndefined();
  });

  it("still routes auto when off, since auto asks for it", () => {
    expect(routeSpawn(input({ mode: "off", requested: "auto" }))).toMatchObject({
      mode: "off",
      profile: "bd-implementer-lite",
      source: "auto",
    });
  });

  it("gives no decision for an explicit profile with no task", () => {
    expect(routeSpawn(input({ taskId: undefined }))).toBeUndefined();
  });

  it("keeps the requested profile when the table could not be read", () => {
    expect(routeSpawn(input({ requested: "auto", table: undefined, tableProblem: "no table" }))).toMatchObject({
      profile: "bd-implementer",
      source: "table-error",
      reason: "no table",
    });
  });

  it("records a planner pick as wanted but never applies it", () => {
    const decision = routeSpawn(input({ requested: "implementer-lite", facts: { ...standardFacts, estimate: 5 } }));

    expect(decision).toMatchObject({ profile: "implementer-lite", source: "agrees", wanted: "bd-planner" });
  });

  it("agrees when the table picks the requested tier", () => {
    expect(routeSpawn(input({ requested: "bd-implementer-lite" }))).toMatchObject({
      profile: "bd-implementer-lite",
      source: "agrees",
    });
  });

  it("routes a task with no owns up, never down", () => {
    expect(routeSpawn(input({ requested: "auto", facts: { ...standardFacts, owns: [] } }))).toMatchObject({
      profile: "bd-implementer",
      prior: "needs-plan",
    });
  });
});

describe("a candidate table in shadow", () => {
  it("records the candidate's pick while the live pick still runs", () => {
    const edited = parseWorkflowTable(TABLE_TEXT.replace("standard: local-fix", "standard: agent-text")).table!;
    const decision = routeSpawn(input({ candidate: { table: edited, id: "shape-v1@bbbb2222" } }));

    expect(decision).toMatchObject({
      profile: "bd-implementer-lite",
      candidate: "shape-v1@bbbb2222",
      candidateWanted: "bd-implementer",
    });
  });
});

describe("the implementer family", () => {
  it.each([
    ["auto", "bd-"],
    ["bd-implementer", "bd-"],
    ["bd-implementer-lite", "bd-"],
    ["implementer", ""],
    ["implementer-lite", ""],
    ["fable-implementer", undefined],
    ["bd-reviewer", undefined],
  ] as const)("%s is in family %j", (profile, family) => {
    expect(implementerFamily(profile)).toBe(family);
  });

  it("maps only the two table tiers into a family", () => {
    expect(inFamily("bd-implementer-lite", "")).toBe("implementer-lite");
    expect(inFamily("bd-implementer", "")).toBe("implementer");
    expect(inFamily("code", "bd-")).toBeUndefined();
  });
});
