import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckRule } from "@titan-design/code-graph";
import { createRegistry, invokeCommand } from "@titan-design/registry";
import { loadReadModel } from "./live-source.js";
import { answer, memorySource, type MemorySnapshot } from "./memory-source.js";
import { CONTRACT, type CommandResult } from "./query/contract.js";
import { createQueryResolver } from "./query/resolver.js";
import { registerCodeReadCommands } from "./register.js";
import { makeFixtureRepo, type FixtureRepo } from "./test-fixtures.js";

type NodeGet = CommandResult<"node.get">;

const ALL_LENSES = ["exports", "score", "centrality", "coupling", "tests"];

const RULES: CheckRule[] = [
  { id: "max-cyclo", type: "metric-max", metric: "cyclomatic_max", kind: "file", max: 1, severity: "warning" },
  { id: "no-src-to-grade", type: "forbid-import", from: "src/report.ts", to: "src/grade.ts" },
];

const GRADE = "export function grade(n: number): string {\n  if (n > 90) return 'a';\n  return n > 70 ? 'c' : 'd';\n}\n";
const REPORT = 'import { grade } from "./grade.js";\n\nexport const top = (ns: number[]): string[] => ns.map((n) => (n > 0 ? grade(n) : "-"));\n';
const MAIN = 'import { top } from "./report.js";\nimport { grade } from "./grade.js";\n\nexport const out = [...top([1]), grade(2)];\n';
const GRADE_TEST = 'import { grade } from "./grade.js";\n\nif (grade(99) !== "a") throw new Error("grade");\n';

let repo: FixtureRepo;
let snapshotId = 0;

beforeAll(async () => {
  repo = await makeFixtureRepo();
  await repo.write("src/grade.ts", GRADE);
  await repo.write("src/report.ts", REPORT);
  await repo.write("src/main.ts", MAIN);
  await repo.write("src/grade.test.ts", GRADE_TEST);
  repo.commit("grade, report, main");
  await repo.write("src/grade.ts", GRADE.replace("return 'a';", "return n > 95 ? 'a+' : 'a';"));
  repo.commit("finer grades");
  snapshotId = await repo.index("main");
}, 60_000);

afterAll(() => repo.cleanup());

async function live(args: object): Promise<NodeGet> {
  const registry = createRegistry();
  registerCodeReadCommands(registry, { openStore: () => repo.store, rules: () => RULES });
  const { envelope } = await invokeCommand(registry.get("node.get")!, args, { warnings: [], format: "json" });
  if (!envelope.ok) throw new Error(`node.get failed: ${envelope.error}`);
  return CONTRACT["node.get"].result.parse(envelope.data);
}

/** The snapshot as a static export holds it: plain JSON, findings already derived. */
function exported(): MemorySnapshot {
  const model = loadReadModel(repo.store, snapshotId, { rules: RULES });
  const { snapshot: info, nodes, edges, findings, rules } = model;
  const metrics = repo.store.listMetrics(snapshotId);
  return JSON.parse(JSON.stringify({ info, nodes, edges, metrics, findings, rules })) as MemorySnapshot;
}

function staticNode(args: object): NodeGet {
  return answer(createQueryResolver(memorySource([exported()])))<NodeGet>("node.get", args);
}

describe("node.get lenses live and static", () => {
  it("export the import rule's destination, so destination-keyed data is in both", () => {
    expect(exported().findings!.some((f) => f.rule === "no-src-to-grade" && f.destinationId === "src/grade.ts")).toBe(true);
  });

  it.each([
    { id: "src/grade.ts" },
    { id: "src/grade.ts", lenses: ALL_LENSES },
    { id: "src/main.ts", lenses: ALL_LENSES, window: "90d" },
    { id: "src/grade.ts#grade", lenses: ALL_LENSES },
    { id: "src/", lenses: ["score", "centrality"] },
  ])("return equal results for %o", async (args) => {
    expect(staticNode(args)).toEqual(await live(args));
  });

  it("read real lenses off the index", async () => {
    const lenses = (await live({ id: "src/grade.ts", lenses: ALL_LENSES })).lenses!;

    expect(lenses.exports).toEqual([expect.objectContaining({ name: "grade", exported: true, consumers: 3 })]);
    expect(lenses.centrality).toMatchObject({ rank: 1, of: 7 });
    expect(lenses.tests).toMatchObject({ tests: [expect.objectContaining({ id: "src/grade.test.ts" })], indexedCount: 1 });
    expect(lenses.score).toMatchObject({ grain: "file", rank: expect.any(Number) });
  });
});
