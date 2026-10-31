#!/usr/bin/env node
// Runs the type-aware lint as bounded parallel eslint processes (lint-units.mjs). One process for the whole repo holds
// a TypeScript program per tsconfig at once and sits at V8's default heap cap, so it aborted depending on GC timing
// (TP-3059).
// Usage: node scripts/lint-types.mjs [--only=<package dir>,...] [extra eslint args]
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TYPED_FILES } from "../eslint.typed.config.js";
import { baselineFinder, groupsInPackages, lintGroups, lintUnits, runEslint, runUnits, TYPED_BASELINE } from "./lint-units.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_CHUNK_FILES = 600;
const MAX_PROCESSES = 4;
const TYPED_CONFIG = "eslint.typed.config.js";

/** Repo files that change every chunk's verdict, so a change to one asks for an unscoped run. */
export const LINT_TYPES_INPUTS = [TYPED_CONFIG];

async function main(args) {
  const only = args.find((arg) => arg.startsWith("--only="));
  const extra = args.filter((arg) => arg !== only);
  const all = lintGroups(ROOT, TYPED_FILES);
  const groups = only ? groupsInPackages(all, only.slice("--only=".length).split(",")) : all;
  const units = lintUnits(groups, baselineFinder(ROOT, TYPED_BASELINE, extra), MAX_CHUNK_FILES);
  const run = (unit) => runEslint(ROOT, unit, { before: ["--config", TYPED_CONFIG, "--no-error-on-unmatched-pattern"], options: extra });
  return runUnits(units, { run, log: (line) => console.error(line), limit: Math.min(availableParallelism(), MAX_PROCESSES) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
