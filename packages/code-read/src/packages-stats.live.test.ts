import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bucketFilesByPackage, computePartitionQuality, filteredFileIds, type CheckRule } from "@titan-design/code-graph";
import { createRegistry, invokeCommand } from "@titan-design/registry";
import { loadReadModel } from "./live-source.js";
import { answer, memorySource, type MemorySnapshot } from "./memory-source.js";
import { CONTRACT, type CommandResult } from "./query/contract.js";
import { createQueryResolver } from "./query/resolver.js";
import { registerCodeReadCommands } from "./register.js";
import { makeFixtureRepo, type FixtureRepo } from "./test-fixtures.js";

type Stats = CommandResult<"packages.stats">;

const RULES: CheckRule[] = [{ id: "tiers", type: "layered-deps", layers: [["packages/core"], ["packages/app"]] }];

const CORE = "export const base = (n: number): number => n + 1;\n";
const CORE_TYPES = "export interface Shape {\n  size: number;\n}\n";
const CORE_USE = 'import type { Shape } from "./types.js";\nimport { base } from "./base.js";\n\nexport const grow = (s: Shape): number => base(s.size);\n';
const APP = 'import { grow } from "../../core/src/use.js";\n\nexport const run = (): number => grow({ size: 2 });\n';
const CLI = 'import { run } from "../../app/src/run.js";\n\nexport const main = (): number => run();\n';
const APP_TEST = 'import { run } from "./run.js";\n\nexport const ok = run() > 0;\n';

let repo: FixtureRepo;
let snapshot = 0;

beforeAll(async () => {
  repo = await makeFixtureRepo();
  await repo.write("packages/core/src/base.ts", CORE);
  await repo.write("packages/core/src/types.ts", CORE_TYPES);
  await repo.write("packages/core/src/use.ts", CORE_USE);
  await repo.write("packages/app/src/run.ts", APP);
  await repo.write("packages/app/src/run.test.ts", APP_TEST);
  await repo.write("packages/cli/src/main.ts", CLI);
  repo.commit("core, app, and cli");
  snapshot = await repo.index("main");
}, 60_000);

afterAll(() => repo.cleanup());

async function live(args: object): Promise<Stats> {
  const registry = createRegistry();
  registerCodeReadCommands(registry, { openStore: () => repo.store, rules: () => RULES });
  const { envelope } = await invokeCommand(registry.get("packages.stats")!, args, { warnings: [], format: "json" });
  if (!envelope.ok) throw new Error(`packages.stats failed: ${envelope.error}`);
  return CONTRACT["packages.stats"].result.parse(envelope.data);
}

/** The snapshot as a static export holds it: plain JSON, rules already reduced to the model's. */
function exported(snapshotId: number): MemorySnapshot {
  const { snapshot: info, nodes, edges, findings, rules } = loadReadModel(repo.store, snapshotId, { rules: RULES });
  const metrics = repo.store.listMetrics(snapshotId);
  return JSON.parse(JSON.stringify({ info, nodes, edges, metrics, findings, rules })) as MemorySnapshot;
}

function staticStats(args: object): Stats {
  return answer(createQueryResolver(memorySource([exported(snapshot)])))<Stats>("packages.stats", args);
}

/** What codewatch's `graph arch --health` computes from the store's default node and edge reads. */
function archQuality(roots: string[]): ReturnType<typeof computePartitionQuality> {
  const nodes = repo.store.listNodes(snapshot);
  const edges = repo.store.listEdges(snapshot);
  const packages = roots.map((id) => ({ id, name: id }));
  return computePartitionQuality({ packages, fileByPackage: bucketFilesByPackage(filteredFileIds(nodes, {}), packages), nodes, edges });
}

describe("packages.stats live and static", () => {
  it.each([{}, { packages: ["packages/core", "packages/app", "packages/cli"] }])("return equal results for %o", async (args) => {
    expect(staticStats(args)).toEqual(await live(args));
  });

  it("match code-graph's partition quality over the same roots", async () => {
    const roots = ["packages/app", "packages/cli", "packages/core"];
    const result = await live({ packages: roots });
    const quality = archQuality(roots);

    expect(result.modularity).toBe(quality.modularityQ);
    expect(result.packages.map((p) => [p.id, p.cohesion, p.instability, p.fileCount])).toEqual(
      quality.perPackage.map((p) => [p.pkgId, p.cohesion, p.instability, p.fileCount]),
    );
    expect(result.crossEdges).toEqual(quality.pairCoupling);
  });

  it("read real tiers and edges off the index, the test file left out", async () => {
    const result = await live({ packages: ["packages/core", "packages/app", "packages/cli"] });
    const byId = Object.fromEntries(result.packages.map((p) => [p.id, p]));

    expect(byId["packages/core"]).toMatchObject({ fileCount: 3, internalEdges: 2, incomingEdges: 1, layer: { status: "declared", tier: 0 } });
    expect(byId["packages/app"]).toMatchObject({ fileCount: 1, outgoingEdges: 1, incomingEdges: 1, layer: { status: "declared", tier: 1 } });
    expect(byId["packages/cli"]).toMatchObject({ fileCount: 1, outgoingEdges: 1, layer: { status: "undeclared" } });
    expect(result.crossEdges.map((c) => [c.from, c.to])).toEqual([["packages/app", "packages/core"], ["packages/cli", "packages/app"]]);
  });
});
