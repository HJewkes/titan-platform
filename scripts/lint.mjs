#!/usr/bin/env node
// The untyped lint: splits its targets into lint-units.mjs's processes, each with its own cache file because eslint's
// cache is not safe to share between processes. Options pass through to every process (--fix, --prune-suppressions).
// Usage: node scripts/lint.mjs <target>... [eslint options, a value joined as --name=value]
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baselineFinder, lintGroups, lintUnits, runEslint, runUnits, UNTYPED_BASELINE } from "./lint-units.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = "node_modules/.cache/lint";
const MAX_PROCESSES = 8;
// Sizes the shared processes; every process here runs on one thread, since a worker thread reloads the config.
const MAX_SHARED_FILES = 800;

/** Named for the unit's first group, which stays stable while the shared unit's membership shrinks. */
const cacheArgs = (unit) => ["--cache", "--cache-strategy", "content", "--cache-location", `${CACHE_DIR}/${unit.groups[0].dir.replace(/\W+/g, "-")}`];

async function main(args) {
  const options = args.filter((arg) => arg.startsWith("-"));
  const groups = lintGroups(ROOT, args.filter((arg) => !arg.startsWith("-")));
  const units = lintUnits(groups, baselineFinder(ROOT, UNTYPED_BASELINE, options), MAX_SHARED_FILES);
  const run = (unit) => runEslint(ROOT, unit, { before: ["--concurrency=off", ...cacheArgs(unit)], options });
  return runUnits(units, { run, log: (line) => console.error(line), limit: Math.min(availableParallelism(), MAX_PROCESSES) });
}

process.exitCode = await main(process.argv.slice(2));
