// Turns one multi-snapshot store into the titan-snapshot@1 fixture the report app is tested against.
// code-graph stamps each snapshot's takenAt with the wall clock at indexing, and IndexOptions cannot
// override it, so the export rewrites takenAt to the indexed commit's date and createdAt to the newest
// one. Two runs over the same refs then write the same bytes.
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCheckRules, openCodeGraph } from "@titan-design/code-graph";
import { createLiveSource, createQueryResolver, type QueryResolver, type SnapshotInfo } from "@titan-design/code-read";
import { buildSnapshot, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { encodeDataset } from "../server/dataset-export.js";
import { firstPaintCalls, type PlannedCall } from "../server/plan.js";
import { CALLS, NO_FILTERS } from "../src/data/calls.js";
import { drillCalls, read, tableCalls, timelineCalls, type FindingsPage } from "./fixture-plan.js";
import { commitDate, type SourceState } from "./history.js";

export interface FixtureOptions {
  dbPath: string;
  rulesPath: string;
  /** The checkout excerpts are read from; only a file still matching its snapshot answers. */
  repoRoot: string;
  outFile: string;
  /** Nodes whose metrics are recorded at every snapshot: the growth timeline's series. */
  timelineNodes: readonly string[];
  /** The checkout the clone was taken from, written beside the calls so a dirty source is on record. */
  provenance: SourceState;
  /** Also embed the whole read model, so calls nobody recorded answer too. Megabytes; not for a committed fixture. */
  withDataset?: boolean;
}

export interface FixtureReport {
  snapshots: number;
  /** Findings in the newest snapshot; the recorded pages are windows onto them. */
  findings: number;
  /** Rows in the recorded first page. */
  rows: number;
  /** One point per timeline node per snapshot. */
  points: number;
  /** Points whose node did not exist in that snapshot: `node.get` answers NOINPUT, not a null value. */
  gaps: number;
  calls: number;
  bytes: number;
}

/** Every call the fixture records, first paint first, with the repeats between plans dropped. */
function planCalls(resolve: QueryResolver, snapshots: readonly SnapshotInfo[], nodes: readonly string[]): PlannedCall[] {
  const newest = snapshots[0]!.id;
  const counts = read<FindingsPage>(resolve("findings.list", CALLS.findingCounts(newest)));
  const page = read<FindingsPage>(resolve("findings.list", CALLS.findingsPage(newest, NO_FILTERS, "severity", 0)));
  const all = [
    ...firstPaintCalls(newest, resolve),
    ...tableCalls(newest, counts),
    ...drillCalls(newest, page),
    ...timelineCalls(snapshots, nodes),
  ];
  const seen = new Set<string>();
  return all.filter((call) => {
    const key = snapshotKey(call.command, call.args);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/** Replaces every snapshot's indexing time with its commit's date, wherever an answer carries one. */
function pinTakenAt(value: unknown, dates: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => pinTakenAt(item, dates));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = pinTakenAt(item, dates);
  const commit = out.commit;
  if (typeof out.takenAt === "string" && typeof commit === "string" && dates.has(commit)) out.takenAt = dates.get(commit);
  return out;
}

export interface FixtureFile extends Snapshot {
  provenance: SourceState;
}

async function writeFixture(file: string, snapshot: FixtureFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(snapshot));
}

/** Records the app's own calls over a real index, and reports what a test can assert about them. */
export async function buildFixture(options: FixtureOptions): Promise<FixtureReport> {
  const rules = await loadCheckRules(options.rulesPath);
  const source = createLiveSource({ openStore: () => openCodeGraph(options.dbPath), rules: () => rules, repoRoot: options.repoRoot });
  const snapshots = source.snapshots();
  if (snapshots.length === 0) throw new Error(`${options.dbPath} holds no snapshots`);
  const resolve = createQueryResolver(source);
  const calls = planCalls(resolve, snapshots, options.timelineNodes);
  const dataset = options.withDataset ? encodeDataset(source, snapshots) : undefined;
  const dates = new Map(snapshots.flatMap((s) => (s.commit ? [[s.commit, commitDate(options.repoRoot, s.commit)] as const] : [])));
  const createdAt = new Date(dates.get(snapshots[0]!.commit ?? "") ?? 0);
  const recorded = await buildSnapshot({ call: (name, args) => Promise.resolve(resolve(name, args)) }, { calls, dataset, createdAt });
  const written = { ...(pinTakenAt(recorded, dates) as Snapshot), provenance: options.provenance };
  await writeFixture(options.outFile, written);
  const counts = read<FindingsPage>(resolve("findings.list", CALLS.findingCounts(snapshots[0]!.id)));
  const page = read<FindingsPage>(resolve("findings.list", CALLS.findingsPage(snapshots[0]!.id, NO_FILTERS, "severity", 0)));
  return {
    snapshots: snapshots.length,
    findings: counts?.total ?? 0,
    rows: page?.rows.length ?? 0,
    points: snapshots.length * options.timelineNodes.length,
    gaps: Object.values(written.calls).filter((envelope) => !envelope.ok).length,
    calls: calls.length,
    bytes: (await stat(options.outFile)).size,
  };
}
