#!/usr/bin/env node
// Pre-push gate on changed files: the CI failures TP-1587 traced to a missing changeset, an oversized file or a type
// error each cost a full CI round trip. Pure planning functions up top; main() at the bottom is the only part that
// touches git, the filesystem or child processes.
// Usage: node scripts/verify-changed.mjs [base]   (base: VERIFY_CHANGED_BASE, then argv, then origin/main)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKED_PAGES, UNIT_GROUPS } from "./gen-docs-reference.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE = "origin/main";
const LOC_RULE_ID = "max-file-loc";
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
// The roots scripts/dag-check-self.mjs indexes; files elsewhere never reach the CI rule.
const GRAPH_ROOT = /^(?:packages|products|apps)\//;
const CODE_GRAPH_ENTRY = join(ROOT, "packages/code-graph/dist/index.js");
const VITEST_TIMEOUT_SECONDS = 600;
const VITEST_HEAP_MB = 4096;

// The languages code-graph's indexer walks (LANGUAGES in its indexer.ts); which extensions `typescript` covers is
// code-parser's call (.mjs and .cjs joined in TP-4161), so nothing here lists them.
const INDEXED_LANGUAGES = ["typescript", "python"];

/**
 * The CI rule's scope, built from the code that decides it: code-graph's ingest filter, its exclude-pattern
 * matcher and its role classifier. Returns a predicate over repo-relative paths.
 */
export function locScope(graph, rule, roleOf) {
  const excluders = graph.compilePatterns(rule.exclude);
  return (path) =>
    GRAPH_ROOT.test(path) &&
    graph.shouldIncludeFile(path, INDEXED_LANGUAGES) &&
    !graph.matchesAny(path, excluders) &&
    !rule.excludeRoles.has(roleOf(path));
}

/** Non-blank line count, the same measure the code-graph `loc` metric uses. */
export function countLoc(content) {
  return content.split("\n").filter((line) => line.trim() !== "").length;
}

/** Threshold, excludes and exempt roles come from the CI rule itself so the two cannot drift. */
export function locRuleFrom(checkConfig) {
  const rule = checkConfig.rules.find((r) => r.id === LOC_RULE_ID);
  if (!rule) throw new Error(`${LOC_RULE_ID} not found in .codewatch/check.json`);
  return { max: rule.max, exclude: rule.exclude ?? [], excludeRoles: new Set(rule.excludeRoles ?? []) };
}

/**
 * The role CI's indexer gives a file, from code-graph's own classifier. Configured role globs would need
 * code-graph's unexported matcher, so a repo that adds .codewatch/roles.json fails here instead of drifting.
 */
export function roleClassifier(graph, root) {
  if (Object.keys(graph.loadRoleGlobs(root)).length > 0) {
    throw new Error(".codewatch/roles.json globs are not applied by verify:changed; teach it roleGlobMatcher first");
  }
  const generated = graph.loadGeneratedPatterns(root);
  return (path) => graph.classifyRole(path, { isGenerated: graph.isGeneratedFile(path, generated) });
}

/** Files over the cap; `readContent` maps a path to its content, or null when the file is gone. */
export function locViolations(changed, rule, readContent, inScope) {
  return changed
    .filter(inScope)
    .flatMap((path) => {
      const content = readContent(path);
      const loc = content === null ? 0 : countLoc(content);
      return loc > rule.max ? [{ path, loc, max: rule.max }] : [];
    });
}

/** The workspace package directory a path belongs to, or null for a path outside every package. */
export function packageDirOf(path) {
  const match = /^(?:packages|products|apps)\/[^/]+/.exec(path);
  return match ? match[0] : null;
}

export function touchedPackageDirs(changed) {
  return [...new Set(changed.map(packageDirOf).filter(Boolean))].sort();
}

/** Packages whose changed files can alter types: a deleted-only or docs-only change needs no tsc. */
export function typecheckDirs(changed, hasTypecheckScript) {
  const typed = changed.filter((path) => SOURCE_EXT.test(path) || /(?:^|\/)tsconfig[^/]*\.json$/.test(path));
  return touchedPackageDirs(typed).filter(hasTypecheckScript);
}

// Inputs the generators read at fixed paths; the rest of the trigger set comes from the generators' own exports.
const FIXED_DOCS_INPUTS = [".codewatch/check.json", "scripts/capabilities-data.json"];
const GENERATOR_ENTRIES = ["scripts/gen-docs-reference.mjs", "scripts/gen-capabilities.mjs"];
const RELATIVE_IMPORT = /\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g;
// Only packages/ has API snapshots (api-snapshots.mjs), built from dist, so these files need a rebuild first.
const SNAPSHOT_INPUT = /^packages\/[^/]+\/(?:src\/|api\/|package\.json$)/;

/** The generator modules and every module they import by relative path; `readSource` maps a repo path to its text. */
export function importClosure(entries, readSource) {
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const [, spec] of readSource(path).matchAll(RELATIVE_IMPORT)) visit(posix.normalize(posix.join(posix.dirname(path), spec)));
  };
  entries.forEach(visit);
  return [...seen];
}

/**
 * Which changed files can fail docs:build and capabilities:check, from what the generators read: the MARKED_PAGES
 * files, each UNIT_GROUPS unit's manifest and CAPABILITY.md, the generator modules and site/. capabilities:check
 * also reads every unit's `export *` walk, covered by all of its src/, and the API snapshots.
 */
export function docsTriggers({ markedPages, unitGroups, generatorModules }) {
  const unit = `^(?:${unitGroups.join("|")})/[^/]+/`;
  const unitDoc = new RegExp(`${unit}(?:package\\.json|CAPABILITY\\.md)$`);
  const unitSource = new RegExp(`${unit}src/`);
  const files = new Set([...Object.keys(markedPages), ...generatorModules, ...FIXED_DOCS_INPUTS]);
  const docs = (path) => path.startsWith("site/") || files.has(path) || unitDoc.test(path);
  const capabilities = (path) => docs(path) || path === "CAPABILITIES.md" || unitSource.test(path) || SNAPSHOT_INPUT.test(path);
  return { docs, capabilities };
}

/** Public packages to rebuild so the snapshots read fresh dist; none when only docs inputs changed. */
export const snapshotBuildDirs = (changed) => touchedPackageDirs(changed.filter((path) => SNAPSHOT_INPUT.test(path)));

/** Packages whose changed files can alter type-aware lint: the same files that can alter types, no script needed. */
export function lintTypesDirs(changed) {
  return typecheckDirs(changed, () => true);
}

export function relatedTestArgs(changed) {
  const sources = changed.filter((path) => SOURCE_EXT.test(path));
  return sources.length === 0 ? null : ["related", "--run", "--passWithNoTests", ...sources];
}

/** Ordered commands after the in-process LOC check; each is argv for spawnSync with optional env. */
export function planCommands({ base, changed, hasTypecheckScript, hasTimeout, triggers }) {
  const commands = [{ label: "changeset status", cmd: "pnpm", args: ["exec", "changeset", "status", `--since=${base}`] }];
  for (const dir of typecheckDirs(changed, hasTypecheckScript)) {
    commands.push({ label: `tsc ${dir}`, cmd: "pnpm", args: ["--dir", dir, "run", "typecheck"] });
  }
  const lintDirs = lintTypesDirs(changed);
  if (lintDirs.length > 0) {
    commands.push({ label: "lint:types", cmd: "node", args: ["scripts/lint-types.mjs", `--only=${lintDirs.join(",")}`] });
  }
  if (changed.some(triggers.capabilities)) {
    const builds = snapshotBuildDirs(changed).flatMap((dir) => ["--filter", `./${dir}`]);
    if (builds.length > 0) commands.push({ label: "build changed packages", cmd: "pnpm", args: [...builds, "run", "--if-present", "build"] });
    commands.push({ label: "capabilities:check", cmd: "pnpm", args: ["run", "capabilities:check"] });
  }
  if (changed.some(triggers.docs)) commands.push({ label: "docs:build", cmd: "pnpm", args: ["run", "docs:build"] });
  const related = relatedTestArgs(changed);
  if (related) {
    const vitest = ["pnpm", "exec", "vitest", ...related];
    // macOS ships without coreutils timeout; an unbounded run beats skipping the tests.
    const [cmd, ...args] = hasTimeout ? ["timeout", String(VITEST_TIMEOUT_SECONDS), ...vitest] : vitest;
    const label = hasTimeout ? "vitest related" : "vitest related (no timeout command, unbounded)";
    commands.push({ label, cmd, args, env: { NODE_OPTIONS: `--max-old-space-size=${VITEST_HEAP_MB}` } });
  }
  return commands;
}

const gitLines = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

function changedFiles(base) {
  const files = new Set([
    ...gitLines(["diff", "--name-only", "--diff-filter=d", `${base}...HEAD`]),
    ...gitLines(["diff", "--cached", "--name-only", "--diff-filter=d"]),
    ...gitLines(["ls-files", "--other", "--modified", "--exclude-standard"]),
  ]);
  return [...files].filter((path) => existsSync(join(ROOT, path)));
}

function hasTypecheckScript(dir) {
  const manifest = join(ROOT, dir, "package.json");
  return existsSync(manifest) && Boolean(JSON.parse(readFileSync(manifest, "utf8")).scripts?.typecheck);
}

/** The trigger predicates for this checkout, built from the generators' exports and their import graph. */
export function generatorTriggers(root = ROOT) {
  const generatorModules = importClosure(GENERATOR_ENTRIES, (path) => readFileSync(join(root, path), "utf8"));
  return docsTriggers({ markedPages: MARKED_PAGES, unitGroups: UNIT_GROUPS, generatorModules });
}

const hasTimeout = () => spawnSync("timeout", ["--version"], { stdio: "ignore" }).error === undefined;

async function overLoc(changed) {
  if (!existsSync(CODE_GRAPH_ENTRY)) throw new Error(`${CODE_GRAPH_ENTRY} not found; run pnpm build first`);
  const graph = await import(CODE_GRAPH_ENTRY);
  const rule = locRuleFrom(JSON.parse(readFileSync(join(ROOT, ".codewatch/check.json"), "utf8")));
  const inScope = locScope(graph, rule, roleClassifier(graph, ROOT));
  return locViolations(changed, rule, (path) => readFileSync(join(ROOT, path), "utf8"), inScope);
}

async function main() {
  const base = process.env.VERIFY_CHANGED_BASE || process.argv[2] || DEFAULT_BASE;
  const changed = changedFiles(base);
  const over = await overLoc(changed);
  for (const v of over) console.error(`verify:changed: ${v.path} has ${v.loc} lines, max ${v.max}`);
  let failed = over.length > 0;
  for (const { label, cmd, args, env } of planCommands({ base, changed, hasTypecheckScript, hasTimeout: hasTimeout(), triggers: generatorTriggers() })) {
    console.log(`verify:changed: ${label}`);
    const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
    if (result.status !== 0) {
      console.error(`verify:changed: ${label} failed`);
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  });
}
