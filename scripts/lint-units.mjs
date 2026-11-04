// Splits a lint pass into eslint processes so each package's baseline is its own file (TP-4633): one root baseline
// made every burn-down PR conflict with every other. --suppressions-location takes one file per run and keys entries
// relative to cwd, so a package with a baseline gets a process of its own, run from the root so the keys stay
// repo-relative. Everything without a baseline shares the fewest processes, which keeps the startup cost bounded and
// shrinks as packages clear. A chunk of typed files also stays well under the V8 heap cap, and an abort is named (TP-3059).
import { spawn } from "node:child_process";
import { existsSync, globSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const UNTYPED_BASELINE = "eslint-suppressions.json";
export const TYPED_BASELINE = "eslint-suppressions.typed.json";

const ESLINT_BIN = join(dirname(createRequire(import.meta.url).resolve("eslint/package.json")), "bin", "eslint.js");
const WORKSPACE_GLOB = /^([^*{]+)\/\*\/(.+)$/;
const PACKAGE_PREFIX = /^[^/*{]+\/[^/*{]+(?=\/)/;
// A target outside every package, such as `scripts`, belongs to the repo root.
const ROOT_PACKAGE = ".";
// Never the root itself, where rootBaselineRefusal would stop the next run.
const ROOT_BASELINE_DIR = "scripts";
// Creating a baseline has to reach packages that have none yet; pruning one leaves those alone.
const CREATES_BASELINE = /^--suppress-(?:all|rule)(?:=|$)/;
const PRUNE = "--prune-suppressions";

/** A target may name a dir, which eslint walks; the count only sizes units, so counting subdirs too is close enough. */
const countFiles = (root, pattern) => globSync([pattern, `${pattern}/**/*`], { cwd: root }).length;

function workspaceGroups(root, parent, rest) {
  if (!existsSync(join(root, parent))) return [];
  return readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`)
    .sort()
    .map((pkg) => ({ pattern: `${pkg}/${rest}`, dir: pkg, pkg, files: countFiles(root, `${pkg}/${rest}`) }))
    .filter((group) => group.files > 0);
}

/** One group per workspace package for a `<parent>/*\/...` glob; any other target is one group, used verbatim. */
export function lintGroups(root, targets) {
  return targets.flatMap((target) => {
    const workspace = WORKSPACE_GLOB.exec(target);
    if (workspace) return workspaceGroups(root, workspace[1], workspace[2]);
    const pkg = PACKAGE_PREFIX.exec(target)?.[0] ?? ROOT_PACKAGE;
    return [{ pattern: target, dir: target, pkg, files: countFiles(root, target) }];
  });
}

/** Keeps the groups inside the given package dirs. */
export const groupsInPackages = (groups, packageDirs) => groups.filter((group) => packageDirs.includes(group.pkg));

/** Greedy packing in input order; a group larger than maxFiles sits alone, since groups are never split. */
export function chunkGroups(groups, maxFiles) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const group of groups) {
    if (current.length > 0 && size + group.files > maxFiles) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(group);
    size += group.files;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * A shared unit names no baseline, so eslint would read a root eslint-suppressions.json by default, and only for the
 * files that unit lints would it report a stale entry. A root file could then hide a new error in any package without
 * a baseline, so a run refuses to start. Returns the refusal, or undefined when no root file exists.
 */
export function rootBaselineRefusal(root) {
  const found = [UNTYPED_BASELINE, TYPED_BASELINE].filter((name) => existsSync(join(root, name)));
  if (found.length === 0) return undefined;
  return `lint refused: ${found.join(", ")} at the repo root. Move its entries into each package's own file and delete it.`;
}

/** Which package gets its own baseline flag: the one with a file, or every package when the run creates baselines. */
export function baselineFinder(root, name, eslintArgs) {
  const creating = eslintArgs.some((arg) => CREATES_BASELINE.test(arg));
  return (pkg) => {
    const path = join(pkg === ROOT_PACKAGE ? ROOT_BASELINE_DIR : pkg, name);
    return creating || existsSync(join(root, path)) ? path : undefined;
  };
}

const unitOf = (groups, baseline) => ({
  groups,
  patterns: groups.map((group) => group.pattern),
  files: groups.reduce((sum, group) => sum + group.files, 0),
  baseline,
});

/** A unit per package with a baseline, then the rest packed up to maxFiles, largest first so the longest run starts earliest. */
export function lintUnits(groups, baselineOf, maxFiles) {
  const owned = new Map();
  const shared = [];
  for (const group of groups) {
    const baseline = baselineOf(group.pkg);
    if (baseline === undefined) shared.push(group);
    else owned.set(baseline, [...(owned.get(baseline) ?? []), group]);
  }
  const ownUnits = [...owned].map(([baseline, members]) => unitOf(members, baseline));
  return [...ownUnits, ...chunkGroups(shared, maxFiles).map((chunk) => unitOf(chunk))].sort((a, b) => b.files - a.files);
}

function dropEmptyBaseline(path) {
  if (Object.keys(JSON.parse(readFileSync(path, "utf8"))).length === 0) rmSync(path);
}

/**
 * Runs one unit. Pruning skips a shared unit, where eslint would write its default root file; a baseline that pruning
 * empties is deleted, so the package rejoins the shared processes.
 */
export async function runEslint(root, unit, { before, options }, spawnUnit = spawnEslint) {
  const pruning = options.includes(PRUNE);
  const suppressions = unit.baseline ? ["--suppressions-location", unit.baseline] : [];
  const passed = unit.baseline ? options : options.filter((option) => option !== PRUNE);
  const result = await spawnUnit(root, [...before, ...suppressions, ...unit.patterns, ...passed]);
  if (pruning && unit.baseline) dropEmptyBaseline(join(root, unit.baseline));
  return result;
}

/** A unit's exit code; V8 aborts on its heap cap, so an abort is named and becomes 2. */
export function chunkExit({ status, signal }, dirs) {
  if (signal === "SIGABRT" || status === 134) {
    return { code: 2, message: `lint chunk ran out of memory at the V8 heap cap: ${dirs.join(", ")}` };
  }
  if (signal) return { code: 2, message: `lint chunk died with ${signal}: ${dirs.join(", ")}` };
  return { code: status ?? 1 };
}

async function runUnit(unit, label, run, log) {
  const dirs = unit.groups.map((group) => group.dir);
  const result = await run(unit);
  log(`${label}: ${dirs.join(" ")} (${unit.files} files)`);
  if (result.output) log(result.output.trimEnd());
  const { code, message } = chunkExit(result, dirs);
  if (message) log(message);
  return code;
}

/**
 * Runs every unit, `limit` at a time and even after one fails, and returns the worst exit code. `worst` is read only
 * after the await: read before it, a clean unit that finished later overwrote a failure, and a stale baseline passed
 * PR CI and turned main red (TP-4651).
 */
export async function runUnits(units, { run, log, limit }) {
  const queue = units.entries();
  let worst = 0;
  const worker = async () => {
    for (const [i, unit] of queue) {
      const code = await runUnit(unit, `lint chunk ${i + 1}/${units.length}`, run, log);
      worst = Math.max(worst, code);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, units.length) }, worker));
  return worst;
}

/** One eslint process with its output held back, so parallel units never interleave. */
function spawnEslint(root, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ESLINT_BIN, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => {
      output += chunk;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", (status, signal) => resolve({ status, signal, output }));
  });
}
