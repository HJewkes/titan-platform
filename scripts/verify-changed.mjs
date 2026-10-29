#!/usr/bin/env node
// Pre-push gate on changed files: the CI failures TP-1587 traced to a missing changeset, an oversized file or a type
// error each cost a full CI round trip. Pure planning functions up top; main() at the bottom is the only part that
// touches git, the filesystem or child processes.
// Usage: node scripts/verify-changed.mjs [base]   (base: VERIFY_CHANGED_BASE, then argv, then origin/main)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LINT_TYPES_INPUTS } from "./lint-types.mjs";
import { readWorkspace, testScope } from "./test-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE = "origin/main";
const LOC_RULE_ID = "max-file-loc";
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
// The roots scripts/dag-check-self.mjs indexes; files elsewhere never reach the CI rule.
const GRAPH_ROOT = /^(?:packages|products|apps)\//;
const CODE_GRAPH_ENTRY = join(ROOT, "packages/code-graph/dist/index.js");
const VITEST_TIMEOUT_SECONDS = 600;
const VITEST_HEAP_MB = 4096;
const TYPE_INPUT = /(?:^|\/)tsconfig[^/]*\.json$/;
const ROOT_SCRIPTS = "scripts/";
const LOC_LABEL = "max-file-loc";

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

export function relatedTestArgs(changed) {
  const sources = changed.filter((path) => SOURCE_EXT.test(path));
  return sources.length === 0 ? null : ["related", "--run", "--passWithNoTests", ...sources];
}

/**
 * Which members lint:types covers, from CI's own test-scope graph so a change reaches the packages that read its
 * types through dist. Inside a member only type inputs count; a path outside every member goes to testScope as is,
 * so one it does not know asks for a full run.
 */
export function lintTypesScope(changed, workspace) {
  if (changed.some((path) => LINT_TYPES_INPUTS.includes(path))) return { mode: "full" };
  const inMember = (path) => workspace.some((member) => path.startsWith(member.dir));
  const inputs = changed.filter((path) => !inMember(path) || SOURCE_EXT.test(path) || TYPE_INPUT.test(path));
  if (inputs.length === 0) return { mode: "none" };
  const scope = testScope(inputs, workspace);
  if (scope.mode !== "scoped") return { mode: scope.mode };
  const dirs = scope.dirs.filter((dir) => dir !== ROOT_SCRIPTS).map((dir) => dir.replace(/\/$/, ""));
  return dirs.length === 0 ? { mode: "none" } : { mode: "scoped", dirs };
}

function lintTypesCommand(changed, workspace) {
  const scope = lintTypesScope(changed, workspace);
  if (scope.mode === "none") return null;
  const only = scope.mode === "scoped" ? [`--only=${scope.dirs.join(",")}`] : [];
  return { label: "lint:types", cmd: "node", args: ["scripts/lint-types.mjs", ...only] };
}

function vitestCommand(changed, hasTimeout, spool) {
  const related = relatedTestArgs(changed);
  if (!related) return null;
  const vitest = ["pnpm", "exec", "vitest", ...related];
  // macOS ships without coreutils timeout; an unbounded run beats skipping the tests.
  const [cmd, ...args] = hasTimeout ? ["timeout", String(VITEST_TIMEOUT_SECONDS), ...vitest] : vitest;
  const label = hasTimeout ? "vitest related" : "vitest related (no timeout command, unbounded)";
  // Each pre-push run leaves a timing record in the spool, so the corpus sees local runs too (TP-4465).
  const timing = { TITAN_TEST_TIMING_SPOOL: spool, TITAN_TEST_TIMING_RUNNER: "verify-changed" };
  return { label, cmd, args, env: { NODE_OPTIONS: `--max-old-space-size=${VITEST_HEAP_MB}`, ...timing } };
}

const pnpmRun = (script) => ({ label: script, cmd: "pnpm", args: ["run", script] });

/**
 * Every ci.yml `run:` step, matched by job and by its command (a string matches the whole command or its leading
 * words). A `label` names the planCommands step that mirrors it; any other disposition says why there is none.
 * verify-changed-coverage.test.mjs fails on a step no row matches and on a labelled row the plan never runs.
 */
export const CI_COVERAGE = [
  { job: ["validate", "dag-check", "perf"], run: "pnpm install --frozen-lockfile", disposition: "setup", reason: "the checkout is installed already" },
  { job: "validate", run: "pnpm env:doctor", disposition: "local", label: "env:doctor" },
  { job: ["validate", "dag-check", "perf"], run: "pnpm build", disposition: "local", label: "build" },
  { job: "validate", run: "pnpm egress:scan range", disposition: "covered-by", reason: "the pre-push hook that prepare installs scans the pushed range" },
  { job: "validate", run: "pnpm merge:lint", disposition: "local", label: "merge:lint" },
  { job: "validate", run: "pnpm sidecar:finds", disposition: "local", label: "sidecar:finds" },
  { job: "validate", run: "pnpm typecheck", disposition: "local", label: "typecheck" },
  { job: "validate", run: "pnpm lint", disposition: "local", label: "lint" },
  { job: "validate", run: /apt-get install|dpkg -i|ImageVersion|playwright-core/, disposition: "setup", reason: "test-runner tooling, not a check" },
  { job: "validate", run: "pnpm test:scope", disposition: "local-subset", label: "vitest related", reason: "the full reverse closure can pass the 600 s cap; CI stays the authority" },
  { job: "validate", run: "pnpm capabilities:check", disposition: "local", label: "capabilities:check" },
  { job: "validate", run: "pnpm metrics:check", disposition: "local", label: "metrics:check" },
  { job: "validate", run: /sunset-manifest\.mjs check/, disposition: "ci-only", reason: "clones agent-chat over the network and only warns" },
  { job: "validate", run: "pnpm docs:build", disposition: "local", label: "docs:build" },
  { job: "validate", run: "pnpm changeset status", disposition: "local", label: "changeset status" },
  { job: "validate", run: "pnpm index-version:check", disposition: "local", label: "index-version:check" },
  { job: "dag-check", run: /INDEX_VERSION|codewatch-summary\.mjs/, disposition: "setup", reason: "cache key and report summary, not a check" },
  { job: "dag-check", run: /^pnpm (?:dag:check:graph|dead:check) /, disposition: "separate-gate", reason: "pnpm dag:check, about 200 s seeded, runs beside verify:changed" },
  { job: "dag-check", run: "pnpm lint:types", disposition: "local-scoped", label: "lint:types", reason: "scoped by lintTypesScope over CI's test-scope graph" },
  { job: "perf", run: "pnpm vitest run --project perf", disposition: "ci-only", reason: "timing budgets need a runner with no other test load, so a local run would not be the authority" },
  { job: "hub-compose", run: /[\s\S]/, disposition: "ci-only", reason: "needs Docker; CI already scopes the job by path" },
];

/**
 * The CI_COVERAGE steps in ci.yml order, each argv for spawnSync with optional env. The cheap checks run on every
 * change: a trigger list that misses an input fails silently, and only CI catches it. LOC runs in-process after the
 * build, which produces the code-graph dist it reads.
 */
export function planCommands({ base, changed, workspace, hasTimeout, spool }) {
  if (changed.length === 0) return [];
  return [
    pnpmRun("env:doctor"),
    pnpmRun("build"),
    { label: LOC_LABEL, inProcess: true },
    pnpmRun("merge:lint"),
    pnpmRun("sidecar:finds"),
    pnpmRun("typecheck"),
    pnpmRun("lint"),
    vitestCommand(changed, hasTimeout, spool),
    pnpmRun("capabilities:check"),
    pnpmRun("metrics:check"),
    pnpmRun("docs:build"),
    { label: "changeset status", cmd: "pnpm", args: ["exec", "changeset", "status", `--since=${base}`] },
    { ...pnpmRun("index-version:check"), env: { BASE_REF: base } },
    lintTypesCommand(changed, workspace),
  ].filter(Boolean);
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

function timingSpool() {
  const home = process.env.TITAN_TEST_TIMING_HOME || join(homedir(), ".local/share/titan-test-timing");
  return process.env.TITAN_TEST_TIMING_SPOOL || join(home, "spool");
}

const hasTimeout = () => spawnSync("timeout", ["--version"], { stdio: "ignore" }).error === undefined;

async function overLoc(changed) {
  if (!existsSync(CODE_GRAPH_ENTRY)) throw new Error(`${CODE_GRAPH_ENTRY} not found; run pnpm build first`);
  const graph = await import(CODE_GRAPH_ENTRY);
  const rule = locRuleFrom(JSON.parse(readFileSync(join(ROOT, ".codewatch/check.json"), "utf8")));
  const inScope = locScope(graph, rule, roleClassifier(graph, ROOT));
  return locViolations(changed, rule, (path) => readFileSync(join(ROOT, path), "utf8"), inScope);
}

// A broken build leaves no code-graph dist; report that as this step's failure and keep running the rest.
async function locPasses(changed) {
  try {
    const over = await overLoc(changed);
    for (const v of over) console.error(`verify:changed: ${v.path} has ${v.loc} lines, max ${v.max}`);
    return over.length === 0;
  } catch (err) {
    console.error(`verify:changed: ${err.message}`);
    return false;
  }
}

async function runStep({ cmd, args, env, inProcess }, changed) {
  if (inProcess) return locPasses(changed);
  return spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } }).status === 0;
}

async function main() {
  const base = process.env.VERIFY_CHANGED_BASE || process.argv[2] || DEFAULT_BASE;
  const changed = changedFiles(base);
  const plan = planCommands({ base, changed, workspace: readWorkspace(ROOT), hasTimeout: hasTimeout(), spool: timingSpool() });
  if (plan.length === 0) console.log(`verify:changed: nothing changed against ${base}`);
  let failed = false;
  for (const step of plan) {
    console.log(`verify:changed: ${step.label}`);
    if (await runStep(step, changed)) continue;
    console.error(`verify:changed: ${step.label} failed`);
    failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  });
}
