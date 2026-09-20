// Rebuilds the committed report fixtures: `pnpm --filter code-report fixtures [--full] [--only platform|design] [--reuse] [--with-dataset]`.
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openCodeGraph } from "@titan-design/code-graph";
import { APP_DIR, REPO_ROOT, RULES_PATH } from "../server/paths.js";
import { buildFixture, type FixtureReport } from "./fixture-export.js";
import { cloneRepo, headCommit, indexRefs, listTags, subsample } from "./history.js";

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
}

function report(name: string, result: FixtureReport): void {
  const kib = (result.bytes / 1024).toFixed(0);
  console.log(`${name}: ${result.snapshots} snapshot(s), ${result.findings} finding(s), ${result.points} timeline point(s) of which ${result.gaps} are gaps, ${result.calls} recorded call(s), ${kib} KiB`);
}

async function scratchClone(source: string, name: string): Promise<string> {
  await mkdir(SCRATCH, { recursive: true });
  return cloneRepo(source, path.join(SCRATCH, name));
}

async function indexPlatform(dbPath: string, clone: string, full: boolean): Promise<void> {
  const tags = listTags(clone);
  const refs = full ? tags : subsample(tags, TAG_STEP, TAG_TAIL);
  console.log(`titan-platform: ${tags.length} tags, indexing ${refs.length}`);
  await rm(dbPath, { force: true });
  const store = openCodeGraph(dbPath);
  await indexRefs(store, {
    repo: clone,
    refs,
    onProgress: (r, ms) => console.log(`  ${r.date} ${r.ref} -> snapshot ${r.snapshotId} (${r.files} files, ${(ms / 1000).toFixed(1)}s)`),
  });
  store.close();
}

async function platformFixture(flags: Flags): Promise<void> {
  const dbPath = path.join(SCRATCH, "titan-platform.db");
  const clone = flags.reuse && existsSync(dbPath) ? path.join(SCRATCH, "titan-platform") : await scratchClone(REPO_ROOT, "titan-platform");
  if (!(flags.reuse && existsSync(dbPath))) await indexPlatform(dbPath, clone, flags.full);
  const out = path.join(FIXTURE_DIR, "titan-platform-history.snapshot.json");
  report("titan-platform-history", await buildFixture({ dbPath, rulesPath: RULES_PATH, repoRoot: clone, outFile: out, timelineNodes: PLATFORM_TIMELINE, withDataset: flags.withDataset }));
}

async function designFixture(flags: Flags): Promise<void> {
  const dbPath = path.join(SCRATCH, "titan-design.db");
  const fresh = !(flags.reuse && existsSync(dbPath));
  const clone = fresh ? await scratchClone(DESIGN_REPO, "titan-design") : path.join(SCRATCH, "titan-design");
  if (fresh) {
    console.log("titan-design: indexing its current main from a clone, so the checkout itself is never touched");
    await rm(dbPath, { force: true });
    const store = openCodeGraph(dbPath);
    const head = { ref: "main", commit: headCommit(clone), date: "" };
    await indexRefs(store, { repo: clone, refs: [head], onProgress: (r, ms) => console.log(`  main ${r.commit.slice(0, 7)} -> snapshot ${r.snapshotId} (${r.files} files, ${(ms / 1000).toFixed(1)}s)`) });
    store.close();
  }
  const out = path.join(FIXTURE_DIR, "titan-design.snapshot.json");
  report("titan-design", await buildFixture({ dbPath, rulesPath: RULES_PATH, repoRoot: clone, outFile: out, timelineNodes: DESIGN_TIMELINE, withDataset: flags.withDataset }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
  const flags: Flags = { full: args.includes("--full"), reuse: args.includes("--reuse"), withDataset: args.includes("--with-dataset") };
  await mkdir(FIXTURE_DIR, { recursive: true });
  if (only !== "design") await platformFixture(flags);
  if (only !== "platform") await designFixture(flags);
}

await main();
