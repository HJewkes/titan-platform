import { CONTRACT, packagesStats, type ReadSource } from "@titan-design/code-read";
import { packageOf, type MapLayout } from "@titan-design/graph-layout";
import { diag, type GatherDiagnostic } from "./diagnostics.js";

const PKG_PREFIX = "pkg:";
const WORKSPACE_ROOT = /^(?:products|apps)\//;

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

/** The map names a package `pkg:<packageOf>`; packages.stats wants its root path. */
function rootOf(boxId: string): string {
  const pkg = boxId.slice(PKG_PREFIX.length);
  return WORKSPACE_ROOT.test(pkg) ? pkg : `packages/${pkg}`;
}

/**
 * One stat card per map package box, numbers from code-read's `packages.stats`. A row whose package
 * reads back as an id the map has no box for gets a `W-CARD-PRUNED` and no card.
 */
export function statCards(
  source: ReadSource,
  snapshotId: number,
  map: MapLayout,
): { cards: StatCard[]; diagnostics: GatherDiagnostic[] } {
  const boxIds = new Set(map.nodes.filter((node) => node.id.startsWith(PKG_PREFIX)).map((node) => node.id));
  const packages = [...boxIds].sort().map(rootOf);
  const args = CONTRACT["packages.stats"].args.parse({ snapshot: snapshotId, packages });
  const cards: StatCard[] = [];
  const diagnostics: GatherDiagnostic[] = [];
  for (const row of packagesStats(source, args).packages) {
    const anchor = PKG_PREFIX + packageOf(`${row.id}/`);
    if (!boxIds.has(anchor)) {
      diagnostics.push(diag("W-CARD-PRUNED", `${row.id} has no package box on the map; no stat card`, anchor));
      continue;
    }
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
