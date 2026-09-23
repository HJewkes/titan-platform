import * as path from "node:path";
import { contentHashOf } from "@titan-design/store-sqlite";
import { resolveBarrelEdges } from "../barrel-resolve.js";
import type { CodeGraphStore } from "../store.js";
import type { GraphEdge, GraphNode } from "../types.js";
import { detectCommunities } from "./communities.js";
import type { ConventionArea, ConventionCorpus, ConventionOptions, ConventionSymbol } from "./types.js";

const DEFAULT_MIN_SIZE = 3;
const PROMPT_FILE_CAP = 30;
const PROMPT_SYMBOL_CAP = 15;

/** Coarse capability-altitude cut: about one area per 25 files, clamped to 6..40. */
export function defaultTargetCount(fileCount: number): number {
  return Math.min(40, Math.max(6, Math.ceil(fileCount / 25)));
}

/**
 * The deterministic half of the convention layer: partition the barrel-resolved
 * file graph into coarse areas and build each area's summarizer prompt and cache key.
 */
export function buildConventionAreas(
  store: CodeGraphStore,
  snapshotId: number,
  opts?: ConventionOptions,
): ConventionCorpus {
  const nodes = store.listNodes(snapshotId, { includeSymbols: true });
  const { files, edges } = resolvedFileGraph(store, snapshotId, nodes);
  const symbolsByFile = collectExportedSymbols(nodes);
  const areas: ConventionArea[] = [];
  const prompts = new Map<string, string>();
  for (const members of partitionFiles(files, edges, opts)) {
    const { area, prompt } = buildArea(members, edges, symbolsByFile);
    areas.push(area);
    prompts.set(area.contentHash, prompt);
  }
  const grouped = areas.reduce((s, a) => s + a.size, 0);
  return { areas, prompts, coverage: { files: files.length, grouped, areas: areas.length, summarized: 0 } };
}

function resolvedFileGraph(
  store: CodeGraphStore,
  snapshotId: number,
  nodes: readonly GraphNode[],
): { files: string[]; edges: GraphEdge[] } {
  const files = nodes
    .filter((n) => n.kind === "file" && n.role !== "generated")
    .map((n) => n.id)
    .sort();
  const fileSet = new Set(files);
  const edges = resolveBarrelEdges(nodes, store.listEdges(snapshotId)).filter(
    (e) => e.srcId !== e.dstId && fileSet.has(e.srcId) && fileSet.has(e.dstId),
  );
  return { files, edges };
}

function partitionFiles(files: readonly string[], edges: readonly GraphEdge[], opts?: ConventionOptions): string[][] {
  const target = opts?.targetCount ?? defaultTargetCount(files.length);
  const minSize = opts?.minSize ?? DEFAULT_MIN_SIZE;
  // A 2x cap on the ideal share keeps a dense repo from snowballing into one indescribable area.
  const maxSize = Math.max(minSize * 2, Math.ceil((files.length / target) * 2));
  return [...detectCommunities(files, edges, { targetCount: target, maxSize }).values()]
    .filter((members) => members.length >= minSize)
    .sort(bySizeThenFirstFile);
}

function bySizeThenFirstFile(a: string[], b: string[]): number {
  if (a.length !== b.length) return b.length - a.length;
  return (a[0] ?? "") < (b[0] ?? "") ? -1 : 1;
}

interface SymbolAttrs {
  exported?: boolean;
  signature?: string;
  purpose?: string;
}

function collectExportedSymbols(nodes: readonly GraphNode[]): Map<string, ConventionSymbol[]> {
  const byFile = new Map<string, ConventionSymbol[]>();
  for (const n of nodes) {
    if (n.kind !== "symbol") continue;
    const attrs = (n.attrs ?? {}) as SymbolAttrs;
    if (attrs.exported !== true || !attrs.signature) continue;
    const file = n.parentId ?? n.id.split("#")[0] ?? n.id;
    const list = byFile.get(file) ?? [];
    list.push({ name: n.name, signature: attrs.signature, purpose: attrs.purpose });
    byFile.set(file, list);
  }
  return byFile;
}

function buildArea(
  members: readonly string[],
  edges: readonly GraphEdge[],
  symbolsByFile: ReadonlyMap<string, ConventionSymbol[]>,
): { area: ConventionArea; prompt: string } {
  const files = rankByDegree(members, edges);
  const label = dominantDirectory(files);
  const topSymbols = pickTopSymbols(files, symbolsByFile);
  const prompt = buildPrompt(label, files, topSymbols);
  const area: ConventionArea = {
    id: `area-${contentHashOf(files.join("\n")).slice(0, 8)}`,
    label,
    files,
    size: files.length,
    topSymbols,
    contentHash: contentHashOf(prompt),
  };
  return { area, prompt };
}

function rankByDegree(members: readonly string[], edges: readonly GraphEdge[]): string[] {
  const memberSet = new Set(members);
  const degree = new Map<string, number>();
  for (const e of edges) {
    if (!memberSet.has(e.srcId) || !memberSet.has(e.dstId)) continue;
    degree.set(e.srcId, (degree.get(e.srcId) ?? 0) + 1);
    degree.set(e.dstId, (degree.get(e.dstId) ?? 0) + 1);
  }
  return [...members].sort((a, b) => {
    const d = (degree.get(b) ?? 0) - (degree.get(a) ?? 0);
    return d !== 0 ? d : a < b ? -1 : 1;
  });
}

function dominantDirectory(files: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const dir = path.posix.dirname(f);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const dirs = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const topDir = dirs[0]?.[0] ?? ".";
  return dirs.length > 1 ? `${topDir} (+${dirs.length - 1} dirs)` : topDir;
}

function pickTopSymbols(
  rankedFiles: readonly string[],
  symbolsByFile: ReadonlyMap<string, ConventionSymbol[]>,
): ConventionSymbol[] {
  const out: ConventionSymbol[] = [];
  for (const file of rankedFiles) {
    for (const sym of symbolsByFile.get(file) ?? []) {
      out.push(sym);
      if (out.length >= PROMPT_SYMBOL_CAP) return out;
    }
  }
  return out;
}

function buildPrompt(label: string, files: readonly string[], symbols: readonly ConventionSymbol[]): string {
  const shown = files.slice(0, PROMPT_FILE_CAP);
  const lines = [
    'You are writing one entry of a repository "convention map" — a',
    "capability-altitude summary coding agents read at PLAN time to learn how",
    "this repo does things and where new code belongs.",
    "",
    `Capability area: ${label}`,
    `Files (${files.length}):`,
    ...shown.map((f) => `- ${f}`),
  ];
  if (files.length > shown.length) lines.push(`- …and ${files.length - shown.length} more`);
  if (symbols.length > 0) {
    lines.push("Key exported symbols:");
    for (const s of symbols) lines.push(`- ${s.signature}${s.purpose ? ` — ${s.purpose}` : ""}`);
  }
  lines.push(
    "",
    "Write 2-3 sentences: (1) what this area does, and (2) HOW — the key entry",
    "points, patterns and conventions to follow when adding related code.",
    "Plain text only, no preamble or headings.",
  );
  return lines.join("\n");
}
