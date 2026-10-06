import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckRule } from "@titan-design/code-graph";
import { createRegistry, invokeCommand } from "@titan-design/registry";
import { loadReadModel } from "./live-source.js";
import { answer, memorySource, type MemorySnapshot } from "./memory-source.js";
import { CONTRACT, type CommandResult } from "./query/contract.js";
import { createQueryResolver } from "./query/resolver.js";
import { registerCodeReadCommands } from "./register.js";
import { makeFixtureRepo, type FixtureRepo } from "./test-fixtures.js";

type Get = CommandResult<"finding.get">;

const RULES: CheckRule[] = [{ id: "max-symbol-loc", type: "metric-max", metric: "symbol_loc", kind: "symbol", max: 3 }];

const header = (n: number): string => Array.from({ length: n }, (_, i) => `// header ${i + 1}`).join("\n");
const BODY = Array.from({ length: 6 }, (_, i) => `  total += ${i};`).join("\n");
// walk spans lines 11 to 20, so its excerpt sits mid-file with the default 5 lines either side.
const WALK = `${header(10)}\nexport function walk(): number {\n  let total = 0;\n${BODY}\n  return total;\n}\n${header(10)}\n`;
const FINDING_ID = "max-symbol-loc|src/walk.ts#walk";

let repo: FixtureRepo;
let snapshotId = 0;

beforeAll(async () => {
  repo = await makeFixtureRepo();
  await repo.write("src/walk.ts", WALK);
  repo.commit("walk");
  snapshotId = await repo.index("main");
}, 60_000);

afterAll(() => repo.cleanup());

async function live(args: object): Promise<Get> {
  const registry = createRegistry();
  registerCodeReadCommands(registry, { openStore: () => repo.store, rules: () => RULES, repoRoot: repo.dir });
  const { envelope } = await invokeCommand(registry.get("finding.get")!, args, { warnings: [], format: "json" });
  if (!envelope.ok) throw new Error(`finding.get failed: ${envelope.error}`);
  return CONTRACT["finding.get"].result.parse(envelope.data);
}

/** The snapshot as a static export holds it: plain JSON, findings already derived, the flagged file's text alongside. */
function exported(): MemorySnapshot {
  const { snapshot: info, nodes, edges, findings, rules } = loadReadModel(repo.store, snapshotId, { rules: RULES });
  const metrics = repo.store.listMetrics(snapshotId);
  const sources = { "src/walk.ts": { lines: WALK.split("\n") } };
  return JSON.parse(JSON.stringify({ info, nodes, edges, metrics, findings, rules, sources })) as MemorySnapshot;
}

// Where the text came from differs by construction; everything an agent reads off the excerpt must not.
const sameText = (result: Get): Get => ({ ...result, excerpt: result.excerpt && { ...result.excerpt, origin: "export", contentHash: "" } });

describe("finding.get on a symbol finding live and static", () => {
  it("locates the finding at the symbol's span and excerpts it with context", async () => {
    const { finding, excerpt } = await live({ id: FINDING_ID });

    expect(finding.range).toEqual({ startLine: 11, endLine: 20 });
    expect(excerpt).toMatchObject({ startLine: 6, endLine: 25, highlights: [{ startLine: 11, endLine: 20 }], origin: "worktree" });
  });

  it.each([{ id: FINDING_ID }, { id: FINDING_ID, context_lines: 0 }])("returns equal results for %o", async (args) => {
    const fromStatic = answer(createQueryResolver(memorySource([exported()])))<Get>("finding.get", args);

    expect(sameText(fromStatic)).toEqual(sameText(await live(args)));
  });
});
