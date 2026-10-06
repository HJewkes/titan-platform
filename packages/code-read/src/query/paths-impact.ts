import { hotspotComplexityOf, hotspotScoreOf, type ReportContext, type ViolationBuckets } from "@titan-design/code-graph/analysis";
import { baselineFields, delta, openBaseline } from "./baseline.js";
import { bucketFindings, type Keyed } from "./changes.js";
import type { CommandArgs, CommandResult } from "./contract.js";
import type { Finding, FindingStatus } from "./contract-findings.js";
import type { FindingDelta, ImpactRollup, PathDelta, PathHotspot, PathImpact } from "./contract-paths-impact.js";
import { compareFindings, findingsFor } from "./finding-rows.js";
import { reportContext, scoredRows } from "./hotspots.js";
import type { ReadModel } from "./model.js";
import { modelFor } from "./snapshot-ref.js";
import type { ReadSource } from "./source.js";
import { toRef } from "./tree.js";

type ImpactArgs = CommandArgs<"paths.impact">;
type ImpactResult = CommandResult<"paths.impact">;
type Indexed = Extract<PathImpact, { status: "indexed" }>;

interface Side {
  model: ReadModel;
  ctx: ReportContext;
  hotspots: ReadonlyMap<string, PathHotspot>;
}

interface Comparison {
  baseline: Side;
  status: ReadonlyMap<string, FindingStatus>;
  findings: ReadonlyMap<string, FindingDelta>;
}

interface Reading {
  current: Side;
  open: ReadonlyMap<string, Finding[]>;
  /** Undefined without a baseline; null when the baseline is not comparable. */
  comparison: Comparison | null | undefined;
}

const WORST_FIRST = compareFindings("severity", "desc");

/** Repo-relative form of a path, or null when it lies outside the repo. Absolute paths count only under `root`. */
export function repoRelative(input: string, root: string | undefined): string | null {
  const rel = underRoot(input, root);
  if (rel === null) return null;
  const parts: string[] = [];
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") parts.push(segment);
    else if (parts.pop() === undefined) return null;
  }
  return parts.join("/");
}

function underRoot(input: string, root: string | undefined): string | null {
  if (!input.startsWith("/")) return input;
  if (root === undefined) return null;
  const base = root.replace(/\/+$/, "");
  if (input === base) return "";
  return input.startsWith(`${base}/`) ? input.slice(base.length + 1) : null;
}

const isFile = (model: ReadModel, id: string): boolean => model.nodeById.get(id)?.kind === "file";

/** The ranking `hotspots.list` returns at the file grain, so a rank here is a row number there. */
function sideOf(model: ReadModel, window: string): Side {
  const rows = scoredRows(model, { grain: "file", window });
  const hotspots = new Map(rows.map((r, i) => [r.nodeId, { score: r.score, rank: i + 1 }]));
  return { model, ctx: reportContext(model, window), hotspots };
}

function openByFile(model: ReadModel): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of findingsFor(model)) {
    const rows = out.get(f.node.path);
    if (rows) rows.push(f);
    else out.set(f.node.path, [f]);
  }
  for (const rows of out.values()) rows.sort(WORST_FIRST);
  return out;
}

function statuses(buckets: ViolationBuckets<Keyed>): Map<string, FindingStatus> {
  const status = new Map<string, FindingStatus>();
  for (const u of buckets.unchanged) status.set(u.to.row.id, "carryover");
  for (const u of buckets.worsened) status.set(u.to.row.id, "worsened");
  for (const u of buckets.improved) status.set(u.to.row.id, "improved");
  for (const v of buckets.newViolations) status.set(v.row.id, "new");
  return status;
}

function findingDeltas(buckets: ViolationBuckets<Keyed>): Map<string, FindingDelta> {
  const out = new Map<string, FindingDelta>();
  const count = (v: Keyed, key: keyof FindingDelta): void => {
    const d = out.get(v.row.node.path) ?? { new: 0, worsened: 0, improved: 0, resolved: 0 };
    d[key] += 1;
    out.set(v.row.node.path, d);
  };
  for (const v of buckets.newViolations) count(v, "new");
  for (const u of buckets.worsened) count(u.to, "worsened");
  for (const u of buckets.improved) count(u.to, "improved");
  for (const v of buckets.resolvedViolations) count(v, "resolved");
  return out;
}

function compareTo(current: Side, baseline: Side): Comparison {
  const buckets = bucketFindings(baseline.model, current.model);
  return { baseline, status: statuses(buckets), findings: findingDeltas(buckets) };
}

function deltaOf(row: Indexed, comparison: Comparison): PathDelta {
  const { model, ctx } = comparison.baseline;
  const inBaseline = isFile(model, row.path);
  const scoreBefore = inBaseline ? hotspotScoreOf(ctx, row.path) : null;
  const complexityBefore = inBaseline ? (hotspotComplexityOf(ctx, row.path) ?? null) : null;
  return {
    inBaseline,
    scoreBefore,
    score: delta(row.hotspot.score, scoreBefore),
    complexityBefore,
    complexity: delta(row.complexity, complexityBefore),
    findings: comparison.findings.get(row.path) ?? { new: 0, worsened: 0, improved: 0, resolved: 0 },
  };
}

function indexedRow(input: string, path: string, reading: Reading): Indexed {
  const { current, comparison } = reading;
  const open = reading.open.get(path) ?? [];
  const row: Indexed = {
    status: "indexed",
    input,
    path,
    node: toRef(current.model.nodeById.get(path)!),
    complexity: hotspotComplexityOf(current.ctx, path) ?? null,
    hotspot: current.hotspots.get(path) ?? { score: 0, rank: null },
    findings: comparison ? open.map((f) => ({ ...f, status: comparison.status.get(f.id) ?? "carryover" })) : open,
  };
  if (comparison !== undefined) row.delta = comparison && deltaOf(row, comparison);
  return row;
}

function rowFor(input: string, path: string | null, reading: Reading): PathImpact {
  if (path === null) return { status: "outside-repo", input };
  if (!isFile(reading.current.model, path)) return { status: "not-indexed", input, path };
  return indexedRow(input, path, reading);
}

function rowsFor(args: ImpactArgs, reading: Reading): PathImpact[] {
  const seen = new Set<string>();
  const rows: PathImpact[] = [];
  for (const input of args.paths) {
    const path = repoRelative(input, args.root);
    const key = path ?? `outside:${input}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(rowFor(input, path, reading));
  }
  return rows;
}

const best = (values: (number | null)[], pick: (...n: number[]) => number): number | null => {
  const measured = values.filter((v): v is number => v !== null);
  return measured.length > 0 ? pick(...measured) : null;
};

function rollupDelta(indexed: readonly Indexed[]): NonNullable<ImpactRollup["delta"]> {
  const findings: FindingDelta = { new: 0, worsened: 0, improved: 0, resolved: 0 };
  let score = 0;
  for (const { delta: d, hotspot } of indexed) {
    score += d!.score ?? hotspot.score;
    for (const key of Object.keys(findings) as (keyof FindingDelta)[]) findings[key] += d!.findings[key];
  }
  return { score, findings };
}

function rollupOf(rows: readonly PathImpact[], comparison: Reading["comparison"]): ImpactRollup {
  const indexed = rows.filter((r): r is Indexed => r.status === "indexed");
  const rollup: ImpactRollup = {
    indexed: indexed.length,
    notIndexed: rows.filter((r) => r.status === "not-indexed").length,
    outsideRepo: rows.filter((r) => r.status === "outside-repo").length,
    score: indexed.reduce((sum, r) => sum + r.hotspot.score, 0),
    maxComplexity: best(indexed.map((r) => r.complexity), Math.max),
    topRank: best(indexed.map((r) => r.hotspot.rank), Math.min),
    openFindings: indexed.reduce((sum, r) => sum + r.findings.length, 0),
  };
  if (comparison !== undefined) rollup.delta = comparison && rollupDelta(indexed);
  return rollup;
}

/** `paths.impact`: complexity, hotspot rank, and open findings for each given file, optionally against a baseline. */
export function pathsImpact(source: ReadSource, args: ImpactArgs): ImpactResult {
  const model = modelFor(source, args.snapshot);
  const baseline = openBaseline(source, args.baseline);
  const fields = baselineFields(model, baseline);
  const current = sideOf(model, args.window);
  const comparison = baseline && (fields.comparable ? compareTo(current, sideOf(baseline.model, args.window)) : null);
  const reading: Reading = { current, open: openByFile(model), comparison };
  const rows = rowsFor(args, reading);
  return { snapshotId: model.snapshot.id, ...fields, rows, ranked: current.hotspots.size, rollup: rollupOf(rows, comparison) };
}
