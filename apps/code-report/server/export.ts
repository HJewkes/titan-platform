// Writes dist/report.html, the built page with a titan-snapshot@1 embedded, that opens from disk: `pnpm --filter code-report export`.
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createQueryResolver, type QueryResolver } from "@titan-design/code-read";
import { embedSnapshot } from "@titan-design/react-app";
import { canonicalArgs, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { exportSnapshot } from "@titan-design/rpc-client/node";
import { invokeCommand, type BaseContext, type CommandRegistry } from "@titan-design/registry";
import { CALLS, NO_FILTERS, overviewMetrics } from "../src/data/calls.js";
import { datasetSource } from "../src/data/dataset.js";
import { encodeDataset } from "./dataset-export.js";
import { DIST_DIR } from "./paths.js";
import { createContext, createReportRegistry } from "./registry.js";

const SNAPSHOT_FILE = path.join(DIST_DIR, "report-snapshot.json");
const REPORT_FILE = path.join(DIST_DIR, "report.html");

interface PlannedCall {
  command: string;
  args: unknown;
}

/** What each page asks for on first paint, plus every finding; anything else is answered by the resolver. */
function firstPaintCalls(snapshot: number, resolve: QueryResolver): PlannedCall[] {
  const describe = resolve("api.describe", CALLS.describe());
  const counts = resolve("findings.list", { snapshot, limit: 500 });
  if (!describe.ok || !counts.ok) throw new Error("The dataset cannot answer api.describe or findings.list");
  const metrics = overviewMetrics((describe.data as { metrics: Parameters<typeof overviewMetrics>[0] }).metrics).map((m) => m.name);
  const findings = (counts.data as { rows: Array<{ id: string }> }).rows;
  return [
    { command: "api.describe", args: CALLS.describe() },
    { command: "findings.list", args: CALLS.findingCounts(snapshot) },
    { command: "hierarchy.get", args: CALLS.overviewTree(snapshot, metrics) },
    { command: "findings.list", args: CALLS.findingsPage(snapshot, NO_FILTERS, "severity", 0) },
    ...findings.map((f) => ({ command: "finding.get", args: CALLS.finding(snapshot, f.id) })),
  ];
}

/** Fields that differ by design between a live daemon and a static export. */
function comparable(command: string, envelope: unknown): string {
  const value = structuredClone(envelope) as { data?: Record<string, unknown> };
  if (command === "api.describe" && value.data) {
    delete value.data.dataset;
    delete value.data.capabilities;
  }
  const excerpt = value.data?.excerpt as { origin?: string } | null | undefined;
  if (excerpt) delete excerpt.origin;
  return JSON.stringify(canonicalArgs(value));
}

/** Answers each recorded call through the live registry too, and lists the ones whose answers differ. */
async function liveMismatches(registry: CommandRegistry<BaseContext>, snapshot: Snapshot, plan: readonly PlannedCall[]): Promise<string[]> {
  const mismatched: string[] = [];
  for (const { command, args } of plan) {
    const { envelope } = await invokeCommand(registry.get(command)!, args, createContext());
    const recorded = snapshot.calls[snapshotKey(command, args)];
    if (comparable(command, envelope) !== comparable(command, recorded)) mismatched.push(`${command} ${JSON.stringify(args)}`);
  }
  return mismatched;
}

async function main(): Promise<void> {
  const { registry, source } = await createReportRegistry();
  const newest = source.snapshots()[0];
  if (!newest) throw new Error("The index has no snapshots; run `pnpm --filter code-report index` first");
  const dataset = encodeDataset(source, [newest]);
  const resolve = createQueryResolver(datasetSource(dataset));
  const plan = firstPaintCalls(newest.id, resolve);
  const snapshot = await exportSnapshot(SNAPSHOT_FILE, { call: async (name, args) => resolve(name, args) }, { calls: plan, dataset });
  const page = await readFile(path.join(DIST_DIR, "index.html"), "utf8").catch(() => {
    throw new Error("dist/index.html is missing; run `pnpm --filter code-report build` first");
  });
  await writeFile(REPORT_FILE, embedSnapshot(page, snapshot));
  const mismatched = await liveMismatches(registry, snapshot, plan);
  await report(newest.id, plan.length, mismatched);
}

async function report(snapshotId: number, calls: number, mismatched: readonly string[]): Promise<void> {
  const size = async (file: string): Promise<string> => `${((await stat(file)).size / 1024).toFixed(0)} KiB`;
  console.log(`snapshot ${snapshotId}: recorded ${calls} calls; every other call is answered by the dataset resolver`);
  console.log(`${SNAPSHOT_FILE}: ${await size(SNAPSHOT_FILE)}`);
  console.log(`${REPORT_FILE}: ${await size(REPORT_FILE)} (open it from disk; no server needed)`);
  console.log(`live parity: ${calls - mismatched.length} of ${calls} recorded answers match the live registry`);
  for (const call of mismatched) console.log(`  differs: ${call}`);
  if (mismatched.length > 0) process.exitCode = 1;
}

await main();
