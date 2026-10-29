import { describe, expect, it } from "vitest";
import { parseSlices, readSlices } from "./report.js";

const planOf = (...slices: object[]): string => `\`\`\`burndown-slices\n${JSON.stringify(slices)}\n\`\`\``;

describe("burndown plan slices", () => {
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
