import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffCheckResults, runChecks, violationKey, type CheckRule, type CheckViolation } from "@titan-design/code-graph";
import { createRegistry, invokeCommand } from "@titan-design/registry";
import { toModelRules } from "./findings-live.js";
import { toSnapshotInfo } from "./live-source.js";
import { answer, memorySource, type MemorySnapshot } from "./memory-source.js";
import { CONTRACT, type CommandResult } from "./query/contract.js";
import type { ModelFinding, ModelNode } from "./query/model.js";
import { createQueryResolver } from "./query/resolver.js";
import { registerCodeReadCommands } from "./register.js";
import { makeFixtureRepo, type FixtureRepo } from "./test-fixtures.js";

type Changes = CommandResult<"changes.get">;

const RULES: CheckRule[] = [{ id: "max-loc", type: "metric-max", metric: "loc", kind: "file", max: 3, severity: "warning" }];

const GRADE = "export function grade(n: number): string {\n  if (n > 90) return 'a';\n  return n > 70 ? 'c' : 'd';\n}\n";
const MAIN = 'import { grade } from "./grade.js";\n\nexport const out = grade(2);\nexport const two = grade(3);\nexport const six = grade(6);\n';
const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);
const consts = (n: number): string => Array.from({ length: n }, (_, i) => `export const c${i} = ${i};\n`).join("");

let repo: FixtureRepo;
let first = 0;
let second = 0;

beforeAll(async () => {
  repo = await makeFixtureRepo();
  await repo.write("src/grade.ts", GRADE);
  await repo.write("src/old.ts", consts(5));
  await repo.write("src/shrink.ts", consts(8));
  repo.commit("grade, old, shrink", daysAgo(20));
  first = await repo.index("main");
  await repo.write("src/grade.ts", GRADE.replace("return 'a';", "return n > 95 ? 'a+' : 'a';\n  if (n > 80) return 'b';"));
  await repo.write("src/old.ts", consts(1));
  await repo.write("src/shrink.ts", consts(6));
  await repo.write("src/main.ts", MAIN);
  repo.commit("finer grades, trim old and shrink, add main", daysAgo(10));
  second = await repo.index("main");
}, 60_000);

afterAll(() => repo.cleanup());

async function live(args: object): Promise<Changes> {
  const registry = createRegistry();
  registerCodeReadCommands(registry, { openStore: () => repo.store, rules: () => RULES });
  const { envelope } = await invokeCommand(registry.get("changes.get")!, { baseline: String(first), ...args }, { warnings: [], format: "json" });
  if (!envelope.ok) throw new Error(`changes.get failed: ${envelope.error}`);
  return CONTRACT["changes.get"].result.parse(envelope.data);
}

// The export drops undefined fields when it is serialized, as a static export's JSON does.
function toFinding(v: CheckViolation): ModelFinding {
  const { ruleId: rule, severity, nodeId, metric, value, threshold, message } = v;
  return { id: violationKey(v), rule, severity, nodeId, message, metric, value, threshold } as ModelFinding;
}

/** One snapshot as an export holds it, read straight from the store, with findings from code-graph's own checker. */
function exported(snapshotId: number): MemorySnapshot {
  const nodes: ModelNode[] = repo.store.listNodes(snapshotId, { includeSymbols: true }).map((n) => ({ ...n, parentId: n.parentId ?? null, attrs: n.attrs ?? {} }));
  const findings = runChecks(repo.store, { snapshotId, rules: RULES }).violations.map(toFinding);
  const info = toSnapshotInfo(repo.store.getSnapshot(snapshotId)!);
  const snapshot = { info, nodes, metrics: repo.store.listMetrics(snapshotId), findings, rules: toModelRules(RULES) };
  return JSON.parse(JSON.stringify(snapshot)) as MemorySnapshot;
}

function staticChanges(args: object): Changes {
  return answer(createQueryResolver(memorySource([exported(second), exported(first)])))<Changes>("changes.get", { baseline: first, ...args });
}

describe("changes.get live and static", () => {
  it.each([{}, { cutoff: 0 }, { limit: 1 }, { window: "90d" }])("return equal results for %o", async (args) => {
    const fromLive = await live(args);

    expect(fromLive.comparable).toBe(true);
    expect(fromLive.counts.regressions).toBeGreaterThan(0);
    expect(staticChanges(args)).toEqual(fromLive);
  });

  it("buckets findings as code-graph's store-backed diffCheckResults does", async () => {
    const { findings } = await live({ limit: 500 });
    const diff = diffCheckResults(repo.store, { fromSnapshotId: first, toSnapshotId: second, rules: RULES });
    const keys = (vs: readonly CheckViolation[]): string[] => vs.map(violationKey).sort();

    expect(findings.new.map((f) => f.id).sort()).toEqual(keys(diff.newViolations));
    expect(findings.resolved.map((f) => f.id).sort()).toEqual(keys(diff.resolvedViolations));
    expect(findings.worsened.map((c) => c.finding.id).sort()).toEqual(keys(diff.worsened.map((u) => u.to)));
    expect(findings.improved.map((c) => c.finding.id).sort()).toEqual(keys(diff.improved.map((u) => u.to)));
  });

  it("reports each change of the fixture in its bucket", async () => {
    const result = await live({ limit: 500 });
    const grade = result.regressions.find((r) => r.node.id === "src/grade.ts")!;

    expect(result.files.added.map((f) => f.node.id)).toEqual(["src/main.ts"]);
    expect(result.findings.new.map((f) => f.id)).toEqual(["max-loc|src/main.ts"]);
    expect(result.findings.worsened.map((c) => c.finding.id)).toEqual(["max-loc|src/grade.ts"]);
    expect(result.findings.improved.map((c) => c.finding.id)).toEqual(["max-loc|src/shrink.ts"]);
    expect(result.findings.resolved.map((f) => f.id)).toEqual(["max-loc|src/old.ts"]);
    expect(grade.findings).toEqual(["max-loc|src/grade.ts"]);
    expect((await live({ cutoff: grade.after })).files.crossedCutoff.map((r) => r.node.id)).toContain("src/grade.ts");
  });
});
