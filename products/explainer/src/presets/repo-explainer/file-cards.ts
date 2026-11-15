import { CONTRACT, getNode, type ReadSource } from "@titan-design/code-read";
import type { MapLayout } from "@titan-design/graph-layout";
import { diag, type GatherDiagnostic } from "./diagnostics.js";

const FILE_LEVEL = 3;
const CARD_METRICS = ["loc", "fan_in", "fan_out"] as const;

interface FileCardMetric {
  name: string;
  value: number | null;
  percentile: number | null;
  delta?: number | null;
}

interface FileCard {
  id: string;
  kind: "file";
  anchor: string;
  data: { path: string; loc: number | null; fanIn: number | null; fanOut: number | null; metrics: FileCardMetric[] };
}

function metricsOf(source: ReadSource, snapshotId: number, id: string): FileCardMetric[] {
  const args = CONTRACT["node.get"].args.parse({ snapshot: snapshotId, id, metrics: [...CARD_METRICS] });
  return getNode(source, args).metrics.map((m) => ({
    name: m.name,
    value: m.value,
    percentile: m.percentile,
    ...(m.delta === undefined ? {} : { delta: m.delta }),
  }));
}

function cardFor(id: string, anchor: string, metrics: FileCardMetric[]): FileCard {
  const value = (name: string) => metrics.find((m) => m.name === name)?.value ?? null;
  return {
    id: `card:${id}`,
    kind: "file",
    anchor,
    data: { path: id, loc: value("loc"), fanIn: value("fan_in"), fanOut: value("fan_out"), metrics },
  };
}

/**
 * One file card per map file, numbers from code-read's `node.get`. A file the map folded into a
 * `+N more` box has no file-level node to anchor to, so it gets a `W-CARD-PRUNED` and no card.
 */
export function fileCards(
  source: ReadSource,
  snapshotId: number,
  map: MapLayout,
  fileIds: Iterable<string>,
): { cards: FileCard[]; diagnostics: GatherDiagnostic[] } {
  const anchors = new Set(map.nodes.filter((node) => node.level === FILE_LEVEL && node.kind === "file").map((node) => node.id));
  const cards: FileCard[] = [];
  const diagnostics: GatherDiagnostic[] = [];
  for (const id of [...new Set(fileIds)].sort()) {
    if (anchors.has(id)) cards.push(cardFor(id, id, metricsOf(source, snapshotId, id)));
    else diagnostics.push(diag("W-CARD-PRUNED", `${id} is folded into a "+N more" box on the map; no file card`, id));
  }
  return { cards, diagnostics };
}
