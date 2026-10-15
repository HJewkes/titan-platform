#!/usr/bin/env node
// Runs the type-aware lint as sequential eslint processes, one per chunk of workspace src dirs. One process for the
// whole repo holds a TypeScript program per tsconfig at once and sits at V8's default heap cap, so it aborted
// depending on GC timing (TP-3059). A chunk stays well under the cap, and a chunk that still aborts is named.
// Usage: node scripts/lint-types.mjs [extra eslint args]
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TYPED_FILES } from "../eslint.typed.config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_CHUNK_FILES = 600;
const ESLINT_BIN = join(dirname(createRequire(import.meta.url).resolve("eslint/package.json")), "bin", "eslint.js");
const WORKSPACE_GLOB = /^([^*{]+)\/\*\/src\/(.+)$/;

const countFiles = (root, pattern) => globSync(pattern, { cwd: root }).length;

function workspaceGroups(root, parent, rest) {
  if (!existsSync(join(root, parent))) return [];
  return readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}/src`)
    .sort()
    .map((dir) => ({ pattern: `${dir}/${rest}`, dir, files: countFiles(root, `${dir}/${rest}`) }))
    .filter((group) => group.files > 0);
}

/** One group per workspace src dir for a `<parent>/*\/src/...` glob; any other glob is one group, used verbatim. */
export function typedGroups(root, typedFiles) {
  return typedFiles.flatMap((glob) => {
    const workspace = WORKSPACE_GLOB.exec(glob);
    if (workspace) return workspaceGroups(root, workspace[1], workspace[2]);
    return [{ pattern: glob, dir: glob, files: countFiles(root, glob) }];
  });
}

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

/** A chunk's exit code; V8 aborts on its heap cap, so an abort is named and becomes 2. */
export function chunkExit({ status, signal }, dirs) {
  if (signal === "SIGABRT" || status === 134) {
    return { code: 2, message: `lint:types chunk ran out of memory at the V8 heap cap: ${dirs.join(", ")}` };
  }
  if (signal) return { code: 2, message: `lint:types chunk died with ${signal}: ${dirs.join(", ")}` };
  return { code: status ?? 1 };
}

/** Runs every chunk, even after one fails, and returns the worst exit code. */
export function runChunks(chunks, run, log) {
  let worst = 0;
  chunks.forEach((chunk, i) => {
    const dirs = chunk.map((group) => group.dir);
    const files = chunk.reduce((sum, group) => sum + group.files, 0);
    log(`lint:types chunk ${i + 1}/${chunks.length}: ${dirs.join(" ")} (${files} files)`);
    const { code, message } = chunkExit(run(chunk.map((group) => group.pattern)), dirs);
    if (message) log(message);
    worst = Math.max(worst, code);
  });
  return worst;
}

function eslintRunner(extraArgs) {
  const base = ["--config", "eslint.typed.config.js", "--suppressions-location", "eslint-suppressions.typed.json"];
  return (patterns) =>
    spawnSync(process.execPath, [ESLINT_BIN, ...base, "--no-error-on-unmatched-pattern", ...patterns, ...extraArgs], {
      cwd: ROOT,
      stdio: "inherit",
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = chunkGroups(typedGroups(ROOT, TYPED_FILES), MAX_CHUNK_FILES);
  process.exitCode = runChunks(chunks, eslintRunner(process.argv.slice(2)), (line) => console.error(line));
}
