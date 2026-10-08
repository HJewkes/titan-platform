import {
  bucketViolations,
  computeReportDrift,
  hotspotScoreOf,
  keepNode,
  type BucketableViolation,
  type ReportContext,
  type UnchangedViolation,
  type ViolationBuckets,
} from "@titan-design/code-graph/analysis";
import type { CommandArgs, CommandResult } from "./contract.js";
import type { FindingChange, NewFile, Regression, ScoreChange } from "./contract-changes.js";
import type { Finding } from "./contract-findings.js";
import { findingsFor } from "./finding-rows.js";
import { driftBaseline, reportContext, scoredRows } from "./hotspots.js";
import type { ReadModel } from "./model.js";
import { modelFor } from "./snapshot-ref.js";
import type { ReadSource } from "./source.js";
import { toRef } from "./tree.js";

type ChangesArgs = CommandArgs<"changes.get">;
type ChangesResult = CommandResult<"changes.get">;
type Lists = Omit<ChangesResult, "snapshotId" | "baselineSnapshotId" | "comparable" | "counts">;

interface Side {
  model: ReadModel;
  ctx: ReportContext;
}

/** A finding as code-graph's bucketing reads it, carrying its contract row along. */
export interface Keyed extends BucketableViolation {
  row: Finding;
}

const byDeltaThenId = (a: ScoreChange, b: ScoreChange): number => b.delta - a.delta || compareIds(a.node.id, b.node.id);
const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Files present at both snapshots whose hotspot score rose, as code-graph's report drift finds them over every row. */
function risingFiles(current: Side, baseline: Side, args: ChangesArgs): ScoreChange[] {
  const scored = (model: ReadModel) => scoredRows(model, { grain: "file", window: args.window });
  const drift = computeReportDrift({
    baselineSnapshot: driftBaseline(baseline.model.snapshot),
    currentHotspots: scored(current.model),
    baselineHotspots: scored(baseline.model),
    currentHotspotScore: (id) => hotspotScoreOf(current.ctx, id),
    baselineHotspotScore: (id) => (baseline.model.nodeById.has(id) ? hotspotScoreOf(baseline.ctx, id) : undefined),
    currentSilos: [],
    baselineSilos: [],
    currentBusFactor: () => undefined,
    currentCoupling: [],
    baselineCoupling: [],
  });
  const climbed = drift.newHotspots.flatMap((r) => (r.before === undefined ? [] : [{ ...r, after: r.score, before: r.before, delta: r.score - r.before }]));
  const node = (id: string) => toRef(current.model.nodeById.get(id)!);
  return [...drift.worsenedHotspots, ...climbed].map((r) => ({ node: node(r.nodeId), before: r.before, after: r.after, delta: r.delta }));
}

function addedFiles(current: Side, baseline: Side): NewFile[] {
  return current.model.nodes
    .filter((n) => n.kind === "file" && !baseline.model.nodeById.has(n.id) && keepNode(current.ctx, n.id))
    .map((n) => ({ node: toRef(n), score: hotspotScoreOf(current.ctx, n.id) }))
    .sort((a, b) => b.score - a.score || compareIds(a.node.id, b.node.id));
}

function keyed(model: ReadModel): Keyed[] {
  return findingsFor(model).map((row) => {
    const k: Keyed = { ruleId: row.rule, nodeId: row.node.id, row };
    if (row.destination) k.destinationId = row.destination.id;
    if (row.value !== undefined) k.value = row.value;
    if (row.threshold !== undefined) k.threshold = row.threshold;
    return k;
  });
}

// Matched by id only, as findings.list matches: following renames through the alias chain is TP-187's identity work.
/** Two snapshots' findings as code-graph buckets them: new, resolved, and unchanged, worsened or improved against the threshold. */
export function bucketFindings(baseline: ReadModel, current: ReadModel): ViolationBuckets<Keyed> {
  const ruleTypes = new Map([...baseline.rules, ...current.rules].map((r) => [r.id, r.type]));
  return bucketViolations(keyed(baseline), keyed(current), undefined, (id) => ruleTypes.get(id));
}

function findingChanges(current: ReadModel, baseline: ReadModel): Lists["findings"] {
  const buckets = bucketFindings(baseline, current);
  const change = (u: UnchangedViolation<Keyed>): FindingChange => ({ finding: u.to.row, before: u.from.value!, delta: u.delta! });
  return {
    new: buckets.newViolations.map((v) => v.row),
    worsened: buckets.worsened.map(change).sort((a, b) => b.delta - a.delta),
    improved: buckets.improved.map(change).sort((a, b) => a.delta - b.delta),
    resolved: buckets.resolvedViolations.map((v) => v.row),
  };
}

/** Rising files that carry an open finding now, on the file or on a symbol in it. */
function regressions(rising: readonly ScoreChange[], current: ReadModel): Regression[] {
  const open = new Map<string, string[]>();
  for (const f of findingsFor(current)) open.set(f.node.path, [...(open.get(f.node.path) ?? []), f.id]);
  return rising.flatMap((r) => {
    const ids = open.get(r.node.id);
    return ids ? [{ ...r, findings: [...ids].sort(compareIds) }] : [];
  });
}

function diff(current: Side, baseline: Side, args: ChangesArgs): Lists {
  const rising = risingFiles(current, baseline, args).sort(byDeltaThenId);
  return {
    files: {
      crossedCutoff: rising.filter((r) => r.after >= args.cutoff && r.before < args.cutoff),
      added: addedFiles(current, baseline),
    },
    findings: findingChanges(current.model, baseline.model),
    // Co-change pairs are not stored in the index yet, so new coupling cannot be measured here.
    coupling: { measured: false, added: [] },
    regressions: regressions(rising, current.model),
  };
}

const EMPTY: Lists = {
  files: { crossedCutoff: [], added: [] },
  findings: { new: [], worsened: [], improved: [], resolved: [] },
  coupling: { measured: false, added: [] },
  regressions: [],
};

function counts(lists: Lists): ChangesResult["counts"] {
  const { files, findings } = lists;
  return {
    crossedCutoff: files.crossedCutoff.length,
    newFiles: files.added.length,
    newFindings: findings.new.length,
    worsened: findings.worsened.length,
    improved: findings.improved.length,
    resolved: findings.resolved.length,
    newCoupling: lists.coupling.added.length,
    regressions: lists.regressions.length,
  };
}

function capped(lists: Lists, limit: number): Lists {
  const cap = <T>(rows: readonly T[]): T[] => rows.slice(0, limit);
  const { files, findings, coupling } = lists;
  return {
    files: { crossedCutoff: cap(files.crossedCutoff), added: cap(files.added) },
    findings: { new: cap(findings.new), worsened: cap(findings.worsened), improved: cap(findings.improved), resolved: cap(findings.resolved) },
    coupling: { measured: coupling.measured, added: cap(coupling.added) },
    regressions: cap(lists.regressions),
  };
}

/** `changes.get`: what moved between a baseline snapshot and this one, or `comparable: false` across index versions. */
export function getChanges(source: ReadSource, args: ChangesArgs): ChangesResult {
  const side = (model: ReadModel): Side => ({ model, ctx: reportContext(model, args.window) });
  const current = side(modelFor(source, args.snapshot));
  const baseline = side(modelFor(source, args.baseline));
  const comparable = baseline.model.snapshot.indexVersion === current.model.snapshot.indexVersion;
  const lists = comparable ? diff(current, baseline, args) : EMPTY;
  return {
    snapshotId: current.model.snapshot.id,
    baselineSnapshotId: baseline.model.snapshot.id,
    comparable,
    ...capped(lists, args.limit),
    counts: counts(lists),
  };
}
