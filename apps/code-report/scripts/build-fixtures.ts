// Rebuilds the committed report fixtures: `pnpm --filter code-report fixtures [--full] [--only platform|design] [--reuse] [--with-dataset] [--require-clean]`.
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openCodeGraph } from "@titan-design/code-graph";
import { APP_DIR, REPO_ROOT, RULES_PATH } from "../server/paths.js";
import { buildFixture, type FixtureReport } from "./fixture-export.js";
import { cloneRepo, headCommit, indexRefs, listTags, sourceState, subsample, type SourceState, type TagRef } from "./history.js";

const FIXTURE_DIR = path.join(APP_DIR, "fixtures");
const SCRATCH = process.env.CODE_REPORT_SCRATCH ?? path.join(os.tmpdir(), "code-report-fixtures");
const DESIGN_REPO = process.env.TITAN_DESIGN_REPO ?? path.join(os.homedir(), "projects/titan-design");

/** Every fourth tag keeps the whole span; the newest three keep the recent releases adjacent. */
const TAG_STEP = 4;
const TAG_TAIL = 3;

/** The repo, a package present at every tag, and one added part way through, which draws a leading gap. */
const PLATFORM_TIMELINE = ["", "packages/code-graph/", "packages/messaging/"];
const DESIGN_TIMELINE = ["", "packages/ui/"];

interface Flags {
  full: boolean;
  /** Index again, or answer from the store a previous run left in the scratch directory. */
  reuse: boolean;
  /** Also embed the read model, so calls nobody recorded answer too. Megabytes; never committed. */
  withDataset: boolean;
  /** Refuse a source with local changes instead of warning; off because titan-design is usually dirty. */
  requireClean: boolean;
}

interface Target {
  name: string;
  source: string;
  timeline: readonly string[];
  /** Churn is measured against today, so it is only right for a snapshot of today's tree. */
  history: boolean;
  refs: (clone: string, flags: Flags) => TagRef[];
}

const TARGETS: Record<"platform" | "design", Target> = {
  platform: {
    name: "titan-platform-history",
    source: REPO_ROOT,
    timeline: PLATFORM_TIMELINE,
    history: false,
    refs: (clone, flags) => (flags.full ? listTags(clone) : subsample(listTags(clone), TAG_STEP, TAG_TAIL)),
  },
  design: {
    name: "titan-design",
    source: DESIGN_REPO,
    timeline: DESIGN_TIMELINE,
    history: true,
    refs: (clone) => [{ ref: "main", commit: headCommit(clone), date: "" }],
  },
};

function report(name: string, result: FixtureReport): void {
  const kib = (result.bytes / 1024).toFixed(0);
  console.log(`${name}: ${result.snapshots} snapshot(s), ${result.findings} finding(s), ${result.points} timeline point(s) of which ${result.gaps} are gaps, ${result.calls} recorded call(s), ${kib} KiB`);
}

function checkSource(target: Target, flags: Flags): SourceState {
  const state = sourceState(target.source);
  if (!state.dirty) return state;
  const message = `${target.source} has ${state.dirtyFiles} modified or untracked path(s); the fixture is built from commit ${state.commit.slice(0, 7)} without them`;
  if (flags.requireClean) throw new Error(message);
  console.warn(`warning: ${message}`);
  return state;
}

async function indexTarget(target: Target, dbPath: string, clone: string, flags: Flags): Promise<void> {
  const refs = target.refs(clone, flags);
  console.log(`${target.name}: indexing ${refs.length} ref(s) from a clone of ${target.source}`);
  await rm(dbPath, { force: true });
  const store = openCodeGraph(dbPath);
  await indexRefs(store, {
    repo: clone,
    refs,
    history: target.history,
    onProgress: (r, ms) => console.log(`  ${r.ref} ${r.commit.slice(0, 7)} -> snapshot ${r.snapshotId} (${r.files} files, ${(ms / 1000).toFixed(1)}s)`),
  });
  store.close();
}

async function buildTarget(key: keyof typeof TARGETS, flags: Flags): Promise<void> {
  const target = TARGETS[key];
  const provenance = checkSource(target, flags);
  const dbPath = path.join(SCRATCH, `${key}.db`);
  const clone = path.join(SCRATCH, key);
  if (!(flags.reuse && existsSync(dbPath) && existsSync(clone))) {
    await mkdir(SCRATCH, { recursive: true });
    cloneRepo(target.source, clone);
    await indexTarget(target, dbPath, clone, flags);
  }
  const outFile = path.join(FIXTURE_DIR, `${target.name}.snapshot.json`);
  const options = { dbPath, rulesPath: RULES_PATH, repoRoot: clone, outFile, timelineNodes: target.timeline, withDataset: flags.withDataset, provenance };
  report(target.name, await buildFixture(options));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
  const flags: Flags = {
    full: args.includes("--full"),
    reuse: args.includes("--reuse"),
    withDataset: args.includes("--with-dataset"),
    requireClean: args.includes("--require-clean"),
  };
  await mkdir(FIXTURE_DIR, { recursive: true });
  if (only !== "design") await buildTarget("platform", flags);
  if (only !== "platform") await buildTarget("design", flags);
}

await main();
