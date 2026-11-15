import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { indexPaths, openCodeGraph, type CodeGraphStore } from "@titan-design/code-graph";
import { CONTRACT, createLiveSource, packagesStats, type LiveSource } from "@titan-design/code-read";
import { emitRepoMap, packageOf, type MapLayout } from "@titan-design/graph-layout";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { statCards } from "./stat-cards.js";

const PIN = "3333333333333333333333333333333333333333";
const FILES: Record<string, string> = {
  "products/tool/src/main.ts": 'import { lib } from "../../../packages/lib/src/lib.js";\nexport const main = () => lib();\n',
  "products/tool/src/extra.ts": 'import { main } from "./main.js";\nexport const extra = () => main();\n',
  "tools/build.ts": 'import { step } from "./step.js";\nexport const build = () => step();\n',
  "tools/step.ts": "export const step = () => 1;\n",
  "packages/lib/src/lib.ts": "export const lib = () => 1;\n",
  "packages/lib/src/other.ts": 'import { lib } from "./lib.js";\nexport const other = () => lib();\n',
};

let dir: string;
let dbDir: string;
let store: CodeGraphStore;
let snapshotId: number;
let source: LiveSource;
let map: MapLayout;

function graph() {
  return { snapshotId, nodes: store.listNodes(snapshotId), edges: store.listEdges(snapshotId) };
}

function statsRow(root: string) {
  const args = CONTRACT["packages.stats"].args.parse({ snapshot: snapshotId, packages: ["packages/lib", "products/tool", "tools"] });
  return packagesStats(source, args).packages.find((row) => row.id === root)!;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rx-stat-cards-"));
  dbDir = await mkdtemp(join(tmpdir(), "rx-stat-cards-db-"));
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  store = openCodeGraph(join(dbDir, "graph.db"));
  ({ snapshotId } = await indexPaths(store, { paths: [dir], commitHash: PIN, computeMetrics: true, computeChurn: false }));
  source = createLiveSource({ openStore: () => store });
  map = await emitRepoMap(graph());
});

afterAll(async () => {
  store.close();
  await Promise.all([dir, dbDir].map((d) => rm(d, { recursive: true, force: true })));
});

describe("statCards", () => {
  it("anchors every card to a pkg: node id in the map", () => {
    const { cards } = statCards(source, snapshotId, map);

    expect(cards.length).toBe(3);
    const pkgIds = new Set(map.nodes.filter((n) => n.id.startsWith("pkg:")).map((n) => n.id));
    for (const card of cards) expect(pkgIds.has(card.anchor)).toBe(true);
  });

  it("carries packagesStats' numbers for each package", () => {
    const { cards } = statCards(source, snapshotId, map);

    const lib = cards.find((c) => c.anchor === "pkg:lib")!;
    const row = statsRow("packages/lib");
    const expected = {
      fileCount: row.fileCount,
      internalEdges: row.internalEdges,
      incomingEdges: row.incomingEdges,
      outgoingEdges: row.outgoingEdges,
      cohesion: row.cohesion,
      instability: row.instability,
    };
    expect(lib.id).toBe("card:packages/lib");
    expect(lib.kind).toBe("stat");
    expect(lib.data).toEqual(expected);
    expect(lib.data.fileCount).toBe(2);
  });

  it("maps a products/<name> root to the pkg:products/<name> box", () => {
    const { cards } = statCards(source, snapshotId, map);

    const tool = cards.find((c) => c.anchor === "pkg:products/tool")!;
    expect(tool.id).toBe("card:products/tool");
    expect(tool.data.fileCount).toBe(statsRow("products/tool").fileCount);
    expect(tool.data.outgoingEdges).toBeGreaterThan(0);
  });

  it("reads a top-level directory box from its own root, not packages/<name>", () => {
    const { cards } = statCards(source, snapshotId, map);

    const tools = cards.find((c) => c.anchor === "pkg:tools")!;
    expect(tools.id).toBe("card:tools");
    expect(tools.data.fileCount).toBe(2);
    expect(tools.data.internalEdges).toBe(statsRow("tools").internalEdges);
    expect(tools.data.internalEdges).toBe(1);
  });

  it("gives a package box with no file on the map a diagnostic and no card", () => {
    const hollow: MapLayout = { ...map, nodes: map.nodes.filter((n) => n.kind !== "file" || packageOf(n.id) !== "lib") };

    const { cards, diagnostics } = statCards(source, snapshotId, hollow);

    expect(cards.map((c) => c.anchor).sort()).toEqual(["pkg:products/tool", "pkg:tools"]);
    expect(diagnostics.map((d) => [d.code, d.selector])).toEqual([["W-CARD-PRUNED", "pkg:lib"]]);
  });
});
