#!/usr/bin/env node
// Checks the burndown port map against agent-chat's src/agents/burndown/ at a ref, and refreshes the map's per-file facts.
// Usage: node scripts/burndown-port-map.mjs check [--agent-chat <dir>] [--ref <sha>] [--map <file>]
//        node scripts/burndown-port-map.mjs facts --ref <sha> [--agent-chat <dir>] [--map <file>]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MAP_PATH = join(ROOT, "products", "factory", "src", "dispatch", "burndown-port-map.json");
const USAGE = "usage: burndown-port-map <check|facts> [--agent-chat <dir>] [--ref <sha>] [--map <file>]";

export function parseArgs(argv, home = homedir()) {
  const [command, ...rest] = argv;
  if (command !== "check" && command !== "facts") throw new Error(USAGE);
  const opts = { command, agentChat: join(home, "projects", "agent-chat"), ref: undefined, map: MAP_PATH };
  const flags = { "--agent-chat": "agentChat", "--ref": "ref", "--map": "map" };
  for (let i = 0; i < rest.length; i++) {
    const key = flags[rest[i]];
    if (!key || rest[i + 1] === undefined) throw new Error(`unknown argument ${rest[i]}; ${USAGE}`);
    opts[key] = key === "ref" ? rest[++i] : resolve(rest[++i]);
  }
  return opts;
}

/** `git ls-tree <ref> <dir>/` output to the blob basenames and the subdirectories, which the map cannot hold. */
export function parseLsTree(output) {
  const files = [];
  const subdirs = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    const name = path.slice(path.lastIndexOf("/") + 1);
    (meta.split(" ")[1] === "tree" ? subdirs : files).push(name);
  }
  return { files, subdirs };
}

/** Sibling modules a burndown source imports, as basenames; imports that leave the directory are not internal. */
export function parseImports(source) {
  const names = new Set();
  for (const m of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]\.\/([\w.-]+)\.js['"]/g)) names.add(`${m[1]}.ts`);
  return [...names].sort();
}

export function diffFiles(mapFiles, listed) {
  const mapped = new Set(mapFiles);
  const present = new Set(listed);
  return { unmapped: listed.filter((f) => !mapped.has(f)), removed: mapFiles.filter((f) => !present.has(f)) };
}

/**
 * Imports from a ported F slice into a destination that is not ported strictly earlier, so the slice cannot land
 * alone. L1 is the store every slice is built on, so an import of it is never forward.
 */
export function forwardEdges(files, order) {
  const level = (dest) => {
    const i = order.findIndex((group) => group.includes(dest));
    return i === -1 ? Infinity : i;
  };
  const destOf = new Map(files.map((f) => [f.file, f.dest]));
  const edges = [];
  for (const { file, dest, imports } of files.filter((f) => /^F\d$/.test(f.dest))) {
    for (const target of imports) {
      const to = destOf.get(target);
      if (to !== dest && to !== "L1" && level(to) >= level(dest)) edges.push({ from: file, fromDest: dest, to: target, toDest: to });
    }
  }
  return edges;
}

/** Non-test files outside burndown/ that import each burndown module, keyed by the module's basename. */
export function parseExternalImporters(grepOutput) {
  const byModule = new Map();
  for (const line of grepOutput.split("\n").filter(Boolean)) {
    const [, path, text] = line.match(/^[^:]+:([^:]+):(.*)$/) ?? [];
    if (!path || /__tests__\/|\.test\.ts$/.test(path)) continue;
    for (const m of text.matchAll(/['"][^'"]*\/burndown\/([\w.-]+)\.js['"]/g)) {
      const importers = byModule.get(`${m[1]}.ts`) ?? new Set();
      byModule.set(`${m[1]}.ts`, importers.add(path));
    }
  }
  return byModule;
}

const BURNDOWN = "src/agents/burndown";
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function listBurndown(agentChat, ref) {
  return parseLsTree(git(agentChat, ["ls-tree", ref, `${BURNDOWN}/`]));
}

function check({ agentChat, ref, map: mapPath }) {
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const at = ref ?? map.source.sha;
  const { files, subdirs } = listBurndown(agentChat, at);
  const { unmapped, removed } = diffFiles(map.files.map((f) => f.file), files);
  console.log(`${files.length} files, ${files.length - unmapped.length} mapped, ${unmapped.length} unmapped, ${removed.length} removed`);
  for (const f of unmapped) console.log(`unmapped: ${f}`);
  for (const f of removed) console.log(`removed: ${f}`);
  for (const d of subdirs) console.log(`subdirectory: ${d} (the map holds files only)`);
  return unmapped.length + removed.length + subdirs.length === 0 ? 0 : 1;
}

function externalImporters(agentChat, ref) {
  const pattern = `['"][^'"]*/burndown/[A-Za-z0-9_.-]+\\.js['"]`;
  const out = git(agentChat, ["grep", "-n", "-E", pattern, ref, "--", "src", `:!${BURNDOWN}`]);
  return parseExternalImporters(out);
}

/** Rewrites only the facts git can derive; destinations are decisions and stay as they are. */
function facts({ agentChat, ref, map: mapPath }) {
  if (!ref) throw new Error(`facts needs --ref; ${USAGE}`);
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const importers = externalImporters(agentChat, ref);
  for (const entry of map.files) {
    const source = git(agentChat, ["show", `${ref}:${BURNDOWN}/${entry.file}`]);
    entry.lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
    entry.imports = entry.file.endsWith(".ts") ? parseImports(source) : [];
    entry.externalImporters = [...(importers.get(entry.file) ?? [])].sort();
  }
  map.source.sha = git(agentChat, ["rev-parse", ref]).trim();
  writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  console.log(`refreshed ${map.files.length} entries at ${map.source.sha}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    process.exitCode = opts.command === "check" ? check(opts) : facts(opts);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}
