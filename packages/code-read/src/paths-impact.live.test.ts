import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckRule } from "@titan-design/code-graph";
import { createRegistry, invokeCommand } from "@titan-design/registry";
import { loadReadModel } from "./live-source.js";
import { answer, memorySource, type MemorySnapshot } from "./memory-source.js";
import { CONTRACT, type CommandResult } from "./query/contract.js";
import { createQueryResolver } from "./query/resolver.js";
import { registerCodeReadCommands } from "./register.js";
import { makeFixtureRepo, type FixtureRepo } from "./test-fixtures.js";

type Impact = CommandResult<"paths.impact">;

const RULES: CheckRule[] = [
  { id: "max-cyclo", type: "metric-max", metric: "cyclomatic_max", kind: "file", max: 1, severity: "warning" },
  { id: "no-src-to-grade", type: "forbid-import", from: "src/report.ts", to: "src/grade.ts" },
];

const GRADE = "export function grade(n: number): string {\n  if (n > 90) return 'a';\n  return n > 70 ? 'c' : 'd';\n}\n";
const REPORT = 'import { grade } from "./grade.js";\n\nexport const top = (ns: number[]): string[] => ns.map((n) => (n > 0 ? grade(n) : "-"));\n';
const MAIN = 'import { top } from "./report.js";\nimport { grade } from "./grade.js";\n\nexport const out = [...top([1]), grade(2)];\n';
const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

let repo: FixtureRepo;
let first = 0;
let second = 0;

beforeAll(async () => {
  repo = await makeFixtureRepo();
  await repo.write("src/grade.ts", GRADE);
  await repo.write("src/report.ts", REPORT);
  repo.commit("grade and report", daysAgo(20));
  first = await repo.index("main");
  await repo.write("src/grade.ts", GRADE.replace("return 'a';", "return n > 95 ? 'a+' : 'a';\n  if (n > 80) return 'b';"));
  await repo.write("src/main.ts", MAIN);
  repo.commit("finer grades, add main", daysAgo(10));
  second = await repo.index("main");
}, 60_000);

afterAll(() => repo.cleanup());

const PATHS = ["src/grade.ts", "./src/main.ts", "src/report.ts", "src/nope.ts", "../outside.ts"];

async function live(args: object, repoRoot?: string): Promise<Impact> {
  const registry = createRegistry();
  registerCodeReadCommands(registry, { openStore: () => repo.store, rules: () => RULES, ...(repoRoot ? { repoRoot } : {}) });
  const { envelope } = await invokeCommand(registry.get("paths.impact")!, { paths: PATHS, ...args }, { warnings: [], format: "json" });
  if (!envelope.ok) throw new Error(`paths.impact failed: ${envelope.error}`);
  return CONTRACT["paths.impact"].result.parse(envelope.data);
}

/** A snapshot as a static export holds it: plain JSON, findings already derived. */
function exported(snapshotId: number): MemorySnapshot {
  const { snapshot: info, nodes, edges, findings, rules } = loadReadModel(repo.store, snapshotId, { rules: RULES });
  const metrics = repo.store.listMetrics(snapshotId);
  return JSON.parse(JSON.stringify({ info, nodes, edges, metrics, findings, rules })) as MemorySnapshot;
}

function staticImpact(args: object): Impact {
  return answer(createQueryResolver(memorySource([exported(second), exported(first)])))<Impact>("paths.impact", { paths: PATHS, ...args });
}

describe("paths.impact live and static", () => {
  it.each([
    {},
    { baseline: "placeholder" },
    { baseline: "placeholder", window: "90d" },
    { root: "placeholder", paths: ["placeholder/src/grade.ts", "/elsewhere/src/grade.ts", "src/main.ts"] },
  ])("return equal results for %o", async (shape) => {
    const args = withFixture(shape);

    expect(staticImpact(args)).toEqual(await live(args));
  });

  it("read real impact off the index, with the import rule's finding on its source file", async () => {
    const result = await live({ baseline: first });
    const byInput = Object.fromEntries(result.rows.map((r) => [r.input, r]));

    expect(byInput["src/grade.ts"]).toMatchObject({ status: "indexed", hotspot: { rank: expect.any(Number) }, delta: { inBaseline: true } });
    expect(byInput["./src/main.ts"]).toMatchObject({ status: "indexed", path: "src/main.ts", delta: { inBaseline: false } });
    expect(byInput["src/report.ts"]).toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ rule: "no-src-to-grade" })]) });
    expect(byInput["src/nope.ts"]).toEqual({ status: "not-indexed", input: "src/nope.ts", path: "src/nope.ts" });
    expect(byInput["../outside.ts"]).toEqual({ status: "outside-repo", input: "../outside.ts" });
    expect(result.rollup).toMatchObject({ indexed: 3, notIndexed: 1, outsideRepo: 1, delta: expect.any(Object) });
  });

  it("read a worktree-absolute path under root as the repo file", async () => {
    const result = await live({ root: repo.dir, paths: [`${repo.dir}/src/grade.ts`, "/elsewhere/src/grade.ts"] });

    expect(result.rows.map((r) => [r.status, "path" in r ? r.path : null])).toEqual([["indexed", "src/grade.ts"], ["outside-repo", null]]);
  });

  it("reject a root above the repo it was indexed from", async () => {
    const parent = repo.dir.slice(0, repo.dir.lastIndexOf("/")) || "/";

    await expect(live({ root: parent, paths: ["src/grade.ts"] }, repo.dir)).rejects.toThrow(/above the index's repo root/);
  });
});

/** The fixture's ids and directory are only known once it is built, so each case names them by placeholder. */
function withFixture(shape: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...shape };
  if (args.baseline) args.baseline = first;
  if (args.root) args.root = repo.dir;
  if (Array.isArray(args.paths)) args.paths = args.paths.map((p: string) => p.replace("placeholder", repo.dir));
  return args;
}
