#!/usr/bin/env node
// Part of `pnpm dag:check`: the workspace package graph must have no cycle. layered-deps lets a package import
// its own tier, so two same-tier packages could import each other and nothing else would object.
// Edges come from package.json dependency fields and from source imports of a workspace package name.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g;

function packageDirs(root) {
  return ["packages", "products"]
    .map((group) => path.join(root, group))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir).map((name) => path.join(dir, name)))
    .filter((dir) => existsSync(path.join(dir, "package.json")));
}

function sourceFiles(dir) {
  const src = path.join(dir, "src");
  if (!existsSync(src)) return [];
  return readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_FILE.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function importedPackages(dir, names) {
  const found = new Set();
  for (const file of sourceFiles(dir)) {
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)) {
      const name = [...names].find((n) => specifier === n || specifier.startsWith(`${n}/`));
      if (name) found.add(name);
    }
  }
  return found;
}

/** Map of workspace package name to the workspace package names it depends on or imports. */
export function packageGraph(root) {
  const manifests = packageDirs(root).map((dir) => ({ dir, manifest: JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) }));
  const names = new Set(manifests.map((m) => m.manifest.name));
  const graph = new Map();
  for (const { dir, manifest } of manifests) {
    const declared = DEP_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {}));
    const edges = new Set([...declared, ...importedPackages(dir, names)].filter((n) => names.has(n)));
    edges.delete(manifest.name);
    graph.set(manifest.name, [...edges].sort());
  }
  return graph;
}

/** Strongly connected components of two or more packages, members sorted. */
export function findCycles(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  let counter = 0;
  const visit = (node) => {
    index.set(node, counter);
    low.set(node, counter++);
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const members = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      members.push(member);
    } while (member !== node);
    if (members.length > 1) cycles.push(members.sort());
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return cycles;
}

if (process.argv[1] === SCRIPT) {
  const cycles = findCycles(packageGraph(ROOT));
  for (const members of cycles) console.error(`package cycle: ${members.join(" <-> ")}`);
  process.exit(cycles.length === 0 ? 0 : 1);
}
