// Fills the test-timing corpus (TP-4465). `ingest-gh` downloads the vitest-file-timing artifacts of finished ci.yml
// runs, main and pull request alike; `ingest-spool` takes the local records verify:changed and basement-suite leave;
// `ingest-dir` takes artifacts already downloaded, for a backfill. Every pass is idempotent, so a timer can rerun it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_ENTRY = join(ROOT, "packages/test-timing/dist/index.js");
const ARTIFACT_FILE = "vitest-file-timing.json";
const META_FIELDS = "databaseId,attempt,headSha,headBranch,event,createdAt";
// gh words "nothing to download" differently by case: no artifacts at all, or none matching the pattern.
const NO_ARTIFACTS = /no valid artifacts|no artifacts? found|no artifact matches/i;

const flag = (argv, name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

export function parseArgs(argv, env = process.env) {
  const home = flag(argv, "--home") ?? env.TITAN_TEST_TIMING_HOME ?? join(homedir(), ".local/share/titan-test-timing");
  return {
    command: argv[0],
    home,
    db: flag(argv, "--db") ?? join(home, "timing.db"),
    repo: flag(argv, "--repo") ?? "HJewkes/titan-platform",
    workflow: flag(argv, "--workflow") ?? "ci.yml",
    limit: Number(flag(argv, "--limit") ?? 100),
    ghRun: flag(argv, "--gh-run"),
    scope: flag(argv, "--scope"),
    dir: argv[0] === "ingest-dir" ? argv[1] : undefined,
  };
}

/** The finished runs of one workflow, newest first; an unfinished run is picked up by a later pass. */
export function listRuns(gh, { repo, workflow, limit }) {
  const args = ["run", "list", "--repo", repo, "--workflow", workflow, "--status", "completed", "--limit", String(limit), "--json", META_FIELDS];
  return JSON.parse(gh(args)).map((run) => ({ ...run, repo }));
}

export function viewRun(gh, repo, id) {
  return { ...JSON.parse(gh(["run", "view", String(id), "--repo", repo, "--json", META_FIELDS])), repo };
}

/** Every `<dir>/<artifact name>/vitest-file-timing.json` under one download, as [name, record]. */
export function readArtifacts(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, ARTIFACT_FILE)))
    .map((entry) => [entry.name, JSON.parse(readFileSync(join(dir, entry.name, ARTIFACT_FILE), "utf8"))]);
}

export function ingestDir(timing, db, home, dir, meta, legacyScope) {
  const artifacts = readArtifacts(dir).filter(([name]) => timing.parseArtifactName(name));
  const results = artifacts.map(([name, record]) => timing.ingestGhArtifact(db, home, name, record, meta, legacyScope));
  return { artifacts: artifacts.length, inserted: results.filter((result) => result.inserted).length };
}

/** Downloads a run's timing artifacts, all attempts at once; a run that uploaded none (a none scope, or expired) is empty. */
function download(gh, run, dir) {
  try {
    gh(["run", "download", String(run.databaseId), "--repo", run.repo, "--pattern", "vitest-file-timing-*", "--dir", dir]);
  } catch (error) {
    if (!NO_ARTIFACTS.test(String(error.stderr ?? error.message))) throw error;
  }
}

const firstLine = (text) => String(text).trim().split("\n")[0];

/** One pass over the newest runs. Each attempt is marked fetched only after its artifacts are stored. */
export function ingestGh(timing, db, { gh, home, scratch, ...options }) {
  const summary = { runs: 0, skipped: 0, artifacts: 0, inserted: 0, failed: [] };
  for (const run of listRuns(gh, options)) {
    if (timing.ghRunFetched(db, run.databaseId, run.attempt)) {
      summary.skipped += 1;
      continue;
    }
    const dir = mkdtempSync(join(scratch, "gh-run-"));
    try {
      download(gh, run, dir);
      const result = ingestDir(timing, db, home, dir, run);
      timing.markGhRunFetched(db, run.databaseId, run.attempt, result.artifacts);
      Object.assign(summary, { runs: summary.runs + 1, artifacts: summary.artifacts + result.artifacts, inserted: summary.inserted + result.inserted });
    } catch (error) {
      summary.failed.push({ run: run.databaseId, reason: firstLine(error.stderr || error.message) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return summary;
}

const liveGh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

function run(timing, db, options) {
  if (options.command === "ingest-gh") return ingestGh(timing, db, { ...options, gh: liveGh, scratch: tmpdir() });
  if (options.command === "ingest-spool") return timing.ingestSpool(db, options.home);
  if (options.command === "ingest-dir") {
    if (options.scope && !["full", "scoped"].includes(options.scope)) throw new Error(`--scope is full or scoped, not ${options.scope}`);
    if (!options.dir || !options.ghRun) throw new Error("usage: ingest-dir <dir> --gh-run <run id> [--scope full|scoped]");
    return ingestDir(timing, db, options.home, options.dir, viewRun(liveGh, options.repo, options.ghRun), options.scope);
  }
  if (options.command === "stats") return timing.storeStats(db);
  throw new Error("usage: test-timing.mjs ingest-gh|ingest-spool|ingest-dir|stats [--home dir] [--repo owner/name] [--limit n]");
}

async function main(argv) {
  const options = parseArgs(argv);
  if (!existsSync(PACKAGE_ENTRY)) throw new Error(`${PACKAGE_ENTRY} not found; run pnpm build first`);
  const timing = await import(PACKAGE_ENTRY);
  mkdirSync(options.home, { recursive: true });
  const db = timing.openTimingStore(options.db);
  try {
    const result = run(timing, db, options);
    console.log(JSON.stringify(result, null, 2));
    return (result.failed?.length ?? 0) + (result.rejected?.length ?? 0) === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
