import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry, invokeCommand } from "@titan-design/registry";
import { toSnapshotInfo } from "./live-source.js";
import { answer, memorySource, type MemorySnapshot } from "./memory-source.js";
import { CONTRACT, type CommandResult } from "./query/contract.js";
import type { ModelNode } from "./query/model.js";
import { createQueryResolver } from "./query/resolver.js";
import { registerCodeReadCommands } from "./register.js";
import { makeFixtureRepo, type FixtureRepo } from "./test-fixtures.js";

type List = CommandResult<"hotspots.list">;

// grade() branches and has two consumers, so it scores at both grains.
const GRADE = [
  "export function grade(n: number): string {",
  "  if (n > 90) return 'a';",
  "  if (n > 80) return 'b';",
  "  return n > 70 ? 'c' : 'd';",
  "}",
  "",
].join("\n");
const REPORT = 'import { grade } from "./grade.js";\n\nexport const top = (ns: number[]): string[] => ns.map((n) => (n > 0 ? grade(n) : "-"));\n';
const SUMMARY = 'import { grade } from "./grade.js";\n\nexport function summary(n: number): string {\n  if (n < 0) return "none";\n  return grade(n);\n}\n';
const MAIN = 'import { top } from "./report.js";\nimport { summary } from "./summary.js";\n\nexport const out = [...top([1]), summary(2)];\n';

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
  await repo.write("src/summary.ts", SUMMARY);
  await repo.write("src/main.ts", MAIN);
  repo.commit("finer grades, add summary");
  second = await repo.index("main");
}, 60_000);

afterAll(() => repo.cleanup());

async function live(args: object): Promise<List> {
  const registry = createRegistry();
  registerCodeReadCommands(registry, { openStore: () => repo.store });
  const { envelope } = await invokeCommand(registry.get("hotspots.list")!, args, { warnings: [], format: "json" });
  if (!envelope.ok) throw new Error(`hotspots.list failed: ${envelope.error}`);
  return CONTRACT["hotspots.list"].result.parse(envelope.data);
}

function exported(snapshotId: number): MemorySnapshot {
  const nodes: ModelNode[] = repo.store.listNodes(snapshotId, { includeSymbols: true }).map((n) => ({
    ...n,
    parentId: n.parentId ?? null,
    attrs: n.attrs ?? {},
  }));
  const metrics = repo.store.listMetrics(snapshotId);
  return JSON.parse(JSON.stringify({ info: toSnapshotInfo(repo.store.getSnapshot(snapshotId)!), nodes, metrics })) as MemorySnapshot;
}

/** The static path: the snapshots as an export holds them, rebuilt and answered by the query resolver. */
function staticList(args: object): List {
  return answer(createQueryResolver(memorySource([exported(second), exported(first)])))<List>("hotspots.list", args);
}

describe("hotspots.list live and static", () => {
  it.each([
    { grain: "file" },
    { grain: "symbol" },
    { grain: "file", baseline: "1" },
    { grain: "symbol", baseline: "1" },
    { grain: "symbol", cutoff: 1, offset: 1, limit: 1 },
  ])("return equal results for %o", async (args) => {
    const fromLive = await live({ limit: 500, ...args });

    expect(fromLive.rows.length).toBeGreaterThan(0);
    expect(staticList({ limit: 500, ...args })).toEqual(fromLive);
  });

  // Every fixture file is minutes old, so recency discounts its file score to 0; the symbol grain applies no recency.
  it("marks the new file new, and the busier grade() worsened at symbol grain", async () => {
    const files = await live({ baseline: first });
    const symbols = await live({ grain: "symbol", baseline: first });

    expect(files.rows.find((r) => r.node.id === "src/summary.ts")).toMatchObject({ baselineScore: null, mark: "new" });
    expect(symbols.rows[0]).toMatchObject({ node: { id: "src/grade.ts#grade" }, mark: "worsened" });
  });
});
