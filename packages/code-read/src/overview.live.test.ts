import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckRule } from "@titan-design/code-graph";
import { createRegistry, invokeCommand } from "@titan-design/registry";
import { loadReadModel } from "./live-source.js";
import { answer, memorySource, type MemorySnapshot } from "./memory-source.js";
import { CONTRACT, type CommandResult } from "./query/contract.js";
import { createQueryResolver } from "./query/resolver.js";
import { registerCodeReadCommands } from "./register.js";
import { makeFixtureRepo, type FixtureRepo } from "./test-fixtures.js";

type Overview = CommandResult<"overview.get">;

const RULES: CheckRule[] = [
  { id: "max-cyclo", type: "metric-max", metric: "cyclomatic_max", kind: "file", max: 1, severity: "warning" },
  { id: "max-loc", type: "metric-max", metric: "loc", kind: "file", max: 4 },
];

const GRADE = "export function grade(n: number): string {\n  if (n > 90) return 'a';\n  return n > 70 ? 'c' : 'd';\n}\n";
const REPORT = 'import { grade } from "./grade.js";\n\nexport const top = (ns: number[]): string[] => ns.map((n) => (n > 0 ? grade(n) : "-"));\n';
const MAIN = 'import { top } from "./report.js";\nimport { grade } from "./grade.js";\n\nexport const out = [...top([1]), grade(2)];\n';

let repo: FixtureRepo;
let first = 0;
let second = 0;

beforeAll(async () => {
  repo = await makeFixtureRepo();
  await repo.write("src/grade.ts", GRADE);
  await repo.write("src/report.ts", REPORT);
  repo.commit("grade");
  first = await repo.index("main");
  await repo.write("src/grade.ts", GRADE.replace("return 'a';", "return n > 95 ? 'a+' : 'a';"));
  await repo.write("src/main.ts", MAIN);
  repo.commit("finer grades, add main");
  second = await repo.index("main");
}, 60_000);

afterAll(() => repo.cleanup());

async function live(args: object): Promise<Overview> {
  const registry = createRegistry();
  registerCodeReadCommands(registry, { openStore: () => repo.store, rules: () => RULES });
  const { envelope } = await invokeCommand(registry.get("overview.get")!, args, { warnings: [], format: "json" });
  if (!envelope.ok) throw new Error(`overview.get failed: ${envelope.error}`);
  return CONTRACT["overview.get"].result.parse(envelope.data);
}

/** One snapshot as a static export holds it: plain JSON, findings already derived. */
function exported(snapshotId: number): MemorySnapshot {
  const model = loadReadModel(repo.store, snapshotId, { rules: RULES });
  const { snapshot: info, nodes, edges, findings, rules } = model;
  const metrics = repo.store.listMetrics(snapshotId);
  return JSON.parse(JSON.stringify({ info, nodes, edges, metrics, findings, rules })) as MemorySnapshot;
}

function staticOverview(args: object): Overview {
  return answer(createQueryResolver(memorySource([exported(second), exported(first)])))<Overview>("overview.get", args);
}

describe("overview.get live and static", () => {
  it.each([
    {},
    { baseline: "1" },
    { cutoff: 0, combined: true, exclude_rules: ["max-loc"], weights: { findings: { each_new: 2 }, complexity: { budget: 0 } } },
    { window: "90d", reading_limit: 1, look_limit: 1 },
  ])("return equal results for %o", async (args) => {
    const fromLive = await live(args);

    expect(fromLive.readingOrder.length).toBeGreaterThan(0);
    expect(fromLive.lookFirst.length).toBeGreaterThan(0);
    expect(fromLive.kpis.findings.open).toBeGreaterThan(0);
    expect(staticOverview(args)).toEqual(fromLive);
  });

  it("reads grade.ts first, as the file both others import", async () => {
    expect((await live({})).readingOrder[0]!.node.id).toBe("src/grade.ts");
  });
});
