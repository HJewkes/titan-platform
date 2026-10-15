import { describe, expect, it } from "vitest";
import { DROP_REASONS, parseReport, parseSlices, readSlices } from "./report.js";

const planOf = (...slices: object[]): string => `\`\`\`burndown-slices\n${JSON.stringify(slices)}\n\`\`\``;

describe("burndown report parser", () => {
  it("reads the status, PR and plan path from a worker or planner report", () => {
    const report = parseReport("\n**Status: DONE_WITH_CONCERNS**\nPR: https://github.com/o/r/pull/9\nPlan: /aw/cc/sources/CC-1-plan.md\n");

    expect(report).toEqual(
      expect.objectContaining({ status: "DONE_WITH_CONCERNS", pr: "https://github.com/o/r/pull/9", plan: "/aw/cc/sources/CC-1-plan.md" }),
    );
  });

  it("reads a reviewer verdict from the first line", () => {
    expect(parseReport("Verdict: APPROVE\nLooks right.").verdict).toBe("APPROVE");
  });

  it("reads a closing PARKED line as the question id, and none when PARKED is not last", () => {
    expect(parseReport("Status: NEEDS_CONTEXT\nAsked which schema to keep.\nPARKED 3f9a").parked).toBe("3f9a");
    expect(parseReport("Status: DONE\nPARKED 3f9a\nPR: https://github.com/o/r/pull/9").parked).toBeUndefined();
  });

  it("yields unknown for a last message it cannot read, never DONE", () => {
    const report = parseReport("I think everything is finished now.");

    expect(report.status).toBe("unknown");
    expect(report.verdict).toBeUndefined();
    expect(report.firstLine).toBe("I think everything is finished now.");
  });

  it("reads a burndown-slices block from a plan file, filling defaults", () => {
    const plan = planOf(
      { n: "a", title: "ledger", points: 2, doneWhen: "ledger test passes", owns: ["src/a.ts"] },
      { n: "b", title: "tick", points: 1, doneWhen: "tick test passes", dependsOn: ["a"], owns: ["src/a.ts"] },
    );

    expect(parseSlices(plan)).toEqual([
      { n: "a", title: "ledger", points: 2, doneWhen: "ledger test passes", dependsOn: [], owns: ["src/a.ts"], contracts: [] },
      { n: "b", title: "tick", points: 1, doneWhen: "tick test passes", dependsOn: ["a"], owns: ["src/a.ts"], contracts: [] },
    ]);
  });

  it.each([
    ["no block", "# Plan\nno slices here", "plan has no burndown-slices block"],
    ["broken JSON", '```burndown-slices\n[{ "n": \n```', "burndown-slices block is not JSON"],
    ["an empty list", "```burndown-slices\n[]\n```", "burndown-slices block:"],
  ])("refuses a plan with %s, saying so", (_, plan, reason) => {
    const read = readSlices(plan);

    expect(read.slices).toBeUndefined();
    expect(read.problems).toEqual([expect.stringContaining(reason)]);
  });

  it("names the path of a contract with an unknown op", () => {
    const read = readSlices(planOf({ n: "a", title: "x", points: 1, doneWhen: "d", owns: ["a"], contracts: [{ scope: "sym:a", op: "delete" }] }));

    expect(read.problems).toEqual([expect.stringContaining("contracts.0.op")]);
  });
});

describe("burndown report proposed tasks need a destination (decision 331)", () => {
  const reportWith = (...items: string[]): string => ["Status: DONE", "PR: https://github.com/o/r/pull/9", "Proposed tasks:", ...items].join("\n");

  it("reads filed, pending and dropped items from a Proposed tasks block", () => {
    const report = parseReport(
      reportWith("- Add a lint rule -> filed TP-9001", "* **Split the parser** -> pending: waits on F4", "- Rename x -> dropped: duplicate", "", "Notes: done"),
    );

    expect(report.proposed).toEqual([
      { text: "Add a lint rule", destination: { kind: "filed", id: "TP-9001" } },
      { text: "Split the parser", destination: { kind: "pending", reason: "waits on F4" } },
      { text: "Rename x", destination: { kind: "dropped", reason: "duplicate" } },
    ]);
    expect(report.refused).toBeUndefined();
    expect(report.status).toBe("DONE");
  });

  it("refuses a report with an item that has no destination, naming the item", () => {
    const report = parseReport(reportWith("- Add a lint rule -> filed TP-9001", "- Retry the flaky test"));

    expect(report.refused).toEqual(expect.stringContaining('"Retry the flaky test" has no destination'));
    expect(report.status).toBe("DONE");
  });

  it("refuses an arrow to something that is not filed, pending or dropped", () => {
    expect(parseReport(reportWith("- Retry the flaky test -> later")).refused).toEqual(expect.stringContaining("has no destination"));
  });

  it.each([
    ["a drop reason off the allow list", "- Rename x -> dropped: not worth it", 'dropped for "not worth it"'],
    ["an empty pending reason", "- Rename x -> pending:", "pending with no reason"],
  ])("refuses %s", (_, item, reason) => {
    expect(parseReport(reportWith(item)).refused).toEqual(expect.stringContaining(reason));
  });

  it.each(DROP_REASONS)("accepts the allow-listed drop reason %s", (reason) => {
    expect(parseReport(reportWith(`- Rename x -> dropped: ${reason}`)).refused).toBeUndefined();
  });

  it("a report with no Proposed tasks block is not refused", () => {
    const report = parseReport("Status: DONE\nPR: https://github.com/o/r/pull/9");

    expect(report.proposed).toBeUndefined();
    expect(report.refused).toBeUndefined();
  });
});

describe("burndown lints planner slices", () => {
  const good = { n: "a", title: "x", points: 2, doneWhen: "a test passes", dependsOn: [], owns: ["src/a.ts"] };

  it("gives one line per failing slice and rule across slices", () => {
    const plan = planOf({ ...good, points: 4, owns: [] }, { ...good, n: "b", dependsOn: ["q"] });

    expect(readSlices(plan).problems).toEqual([
      "slice a: 4 points, over the 3-point limit",
      "slice a: owns no files",
      "slice b: depends on unknown slice q",
    ]);
  });

  it("fails a dependency cycle once, and duplicate slice names", () => {
    const plan = planOf({ ...good, dependsOn: ["b"] }, { ...good, n: "b", dependsOn: ["a"] }, { ...good, n: "c" }, { ...good, n: "c" });

    expect(readSlices(plan).problems).toEqual(["slice c: n is used by more than one slice", "slice a: dependency cycle a -> b -> a"]);
  });

  it("fails a slice whose ops field leaves out an op its doneWhen names", () => {
    const slice = { ...good, doneWhen: "live after a broker restart", ops: ["publish"] };

    expect(readSlices(planOf(slice)).problems).toContain(`slice a: doneWhen mentions restart ('broker restart'), which "ops" does not declare`);
  });

  it("fails a slice that declares a human op, telling the planner to split it out", () => {
    expect(readSlices(planOf({ ...good, ops: ["restart"] })).problems).toEqual([
      "slice a: declares restart; split it into a kind:operator or kind:owner task",
    ]);
  });

  it("gives one lint line for a scope repeated in one slice", () => {
    const contracts = [
      { scope: "sym:a", op: "add" },
      { scope: " sym:a ", op: "extend" },
    ];

    expect(readSlices(planOf({ ...good, contracts })).problems).toEqual(["slice a: contract scope sym:a is declared more than once"]);
  });
});

describe("burndown warns on dependsOn across disjoint owns", () => {
  const slice = (n: string, owns: string[], dependsOn: string[] = [], extra: object = {}) => ({
    n,
    title: n,
    points: 1,
    doneWhen: "a test passes",
    dependsOn,
    owns,
    ...extra,
  });
  const why = { dependsWhy: "needs the earlier export" };

  it("warns on an edge between slices with disjoint owns and no dependsWhy, without blocking", () => {
    const read = readSlices(planOf(slice("a", ["src/a.ts"]), slice("b", ["src/b.ts"], ["a"])));

    expect(read.problems).toBeUndefined();
    expect(read.warnings).toEqual(["slice b: depends on a but their owns are disjoint; set dependsOn [] or say why in dependsWhy"]);
  });

  it("passes an edge between slices whose owns overlap by glob", () => {
    expect(readSlices(planOf(slice("a", ["src/**"]), slice("b", ["src/x.ts"], ["a"]))).warnings).toEqual([]);
  });

  it("warns once on a linear chain of three over disjoint owns, whatever dependsWhy says", () => {
    const plan = planOf(slice("a", ["src/a.ts"]), slice("b", ["src/b.ts"], ["a"], why), slice("c", ["src/c.ts"], ["b"], why));

    expect(readSlices(plan).warnings).toEqual(["slices a -> b -> c form a linear chain over disjoint owns; check each edge is real"]);
  });

  it("warns on a publish mention in a slice with no ops field", () => {
    expect(readSlices(planOf(slice("a", ["src/a.ts"], [], { doneWhen: "publishes the docs site" }))).warnings).toEqual([
      expect.stringContaining("doneWhen mentions publish"),
    ]);
  });
});
