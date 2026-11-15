import { CONTRACT, packagesStats, type ReadSource } from "@titan-design/code-read";
import { packageOf, packageRootOf, type MapLayout } from "@titan-design/graph-layout";
import { diag, type GatherDiagnostic } from "./diagnostics.js";

const PKG_PREFIX = "pkg:";

interface StatCard {
  id: string;
  kind: "stat";
  anchor: string;
  data: {
    fileCount: number;
    internalEdges: number;
    incomingEdges: number;
    outgoingEdges: number;
    cohesion: number;
    instability: number;
  };
}

/** Each package box's root path, read off a file the map shows under it; a box showing no file has none. */
function boxRoots(map: MapLayout): Map<string, string> {
  const roots = new Map<string, string>();
  for (const node of map.nodes) {
    if (node.kind === "file") roots.set(PKG_PREFIX + packageOf(node.id), packageRootOf(node.id));
  }
  return roots;
}

/**
 * One stat card per map package box, numbers from code-read's `packages.stats`. A package box that
 * shows no file has no root to ask for, so it gets a `W-CARD-PRUNED` and no card.
 */
export function statCards(
  source: ReadSource,
  snapshotId: number,
  map: MapLayout,
): { cards: StatCard[]; diagnostics: GatherDiagnostic[] } {
  const boxIds = new Set(map.nodes.filter((node) => node.id.startsWith(PKG_PREFIX)).map((node) => node.id));
  const roots = boxRoots(map);
  const diagnostics: GatherDiagnostic[] = [...boxIds]
    .filter((id) => !roots.has(id))
    .sort()
    .map((id) => diag("W-CARD-PRUNED", `${id} shows no file on the map; no stat card`, id));
  const packages = [...new Set(roots.values())].sort();
  const args = CONTRACT["packages.stats"].args.parse({ snapshot: snapshotId, packages });
  const cards: StatCard[] = [];
  for (const row of packagesStats(source, args).packages) {
    const anchor = PKG_PREFIX + packageOf(`${row.id}/`);
    const { fileCount, internalEdges, incomingEdges, outgoingEdges, cohesion, instability } = row;
    cards.push({
      id: `card:${row.id}`,
      kind: "stat",
      anchor,
      data: { fileCount, internalEdges, incomingEdges, outgoingEdges, cohesion, instability },
    });
  }
  return { cards, diagnostics };
}
