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
import { TYPED_BASELINE } from "./lint-units.mjs";
import { flakeTargets, loadFlakeClasses, repeatGuard } from "./flake-repeat.mjs";
import { readWorkspace, testScope } from "./test-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE = "origin/main";
const LOC_RULE_ID = "max-file-loc";
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
// The roots scripts/dag-check-self.mjs indexes; files elsewhere never reach the CI rule.
const GRAPH_ROOT = /^(?:packages|products|apps)\//;
const CODE_GRAPH_ENTRY = join(ROOT, "packages/code-graph/dist/index.js");
const VITEST_TIMEOUT_SECONDS = 600;
// timeout(1) exits 124 when it kills the command.
const TIMEOUT_EXIT_STATUS = 124;
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
  const scope = inputs.length === 0 ? { mode: "none" } : testScope(inputs, workspace);
  if (scope.mode === "full") return { mode: "full" };
  // A package's own baseline changes only that package's verdict, so it never reaches the dependents.
  const baselines = workspace.filter((member) => changed.includes(`${member.dir}${TYPED_BASELINE}`)).map((member) => member.dir);
  const reached = (scope.dirs ?? []).filter((dir) => dir !== ROOT_SCRIPTS);
  const dirs = [...new Set([...reached, ...baselines])].map((dir) => dir.replace(/\/$/, "")).sort();
  return dirs.length === 0 ? { mode: "none" } : { mode: "scoped", dirs };
}

function lintTypesCommand(changed, workspace) {
  const scope = lintTypesScope(changed, workspace);
  if (scope.mode === "none") return null;
  const only = scope.mode === "scoped" ? [`--only=${scope.dirs.join(",")}`] : [];
  return { label: "lint:types", cmd: "node", args: ["scripts/lint-types.mjs", ...only] };
}

// `vitest related` on a root config file reruns everything, which cannot fit the local cap; CI owns that run.
const DEFERRED_LABEL = "vitest related: full suite selected, deferred to CI";

function vitestCommand(changed, workspace, hasTimeout, spool) {
  const related = relatedTestArgs(changed);
  if (!related) return null;
  // Only the files handed to vitest can make it rerun everything; a lockfile or workflow change does not.
  if (testScope(changed.filter((path) => SOURCE_EXT.test(path)), workspace).mode === "full") return { label: DEFERRED_LABEL, deferred: true };
  const vitest = ["pnpm", "exec", "vitest", ...related];
  // macOS ships without coreutils timeout; an unbounded run beats skipping the tests.
  const [cmd, ...args] = hasTimeout ? ["timeout", String(VITEST_TIMEOUT_SECONDS), ...vitest] : vitest;
  const label = hasTimeout ? "vitest related" : "vitest related (no timeout command, unbounded)";
  // Each pre-push run leaves a timing record in the spool, so the corpus sees local runs too (TP-4465).
  const timing = { TITAN_TEST_TIMING_SPOOL: spool, TITAN_TEST_TIMING_RUNNER: "verify-changed" };
  return { label, cmd, args, env: { NODE_OPTIONS: `--max-old-space-size=${VITEST_HEAP_MB}`, ...timing } };
}

const FLAKE_CLASSES_PATH = join(ROOT, "scripts/flake-classes.json");
const FLAKE_LABEL = "flake repeat";
const NO_FLAKE_CLASSES = { repeats: 1, classes: [] };

/** The repeat-guard step, or null when no changed file is in a flake class (TP-4657). */
export function flakeRepeatStep(changed, flakeClasses, hasTimeout) {
  const targets = flakeTargets(changed, flakeClasses.classes);
  if (targets.length === 0) return null;
  const vitest = ["pnpm", "exec", "vitest", "run"];
  const [cmd, ...prefix] = hasTimeout ? ["timeout", String(VITEST_TIMEOUT_SECONDS), ...vitest] : vitest;
  const label = `${FLAKE_LABEL}: ${flakeClasses.repeats} runs of ${targets.map((t) => `${t.path} [${t.classId}]`).join(", ")}`;
  return { label, flake: true, cmd, prefix, targets, repeats: flakeClasses.repeats, env: { NODE_OPTIONS: `--max-old-space-size=${VITEST_HEAP_MB}` } };
}

/**
 * The graph-root members a change touches. A non-entry module's importers sit in its own package, since other
 * packages import through the manifest entries, so indexing just these members judges their exports as CI does.
 */
function deadCheckDirs(changed, workspace) {
  const touched = workspace.filter((member) => GRAPH_ROOT.test(member.dir) && changed.some((path) => path.startsWith(member.dir)));
  return touched.map((member) => member.dir.replace(/\/$/, "")).sort();
}

// products/active-work's 525 indexed files take about 55 s; the largest products take minutes, so CI owns them.
const DEAD_CHECK_MAX_FILES = 600;
const INDEXED_EXT = /\.(?:[cm]?[jt]sx?|py)$/;

function deadCheckCommand(changed, workspace, base, indexedFiles) {
  const dirs = deadCheckDirs(changed, workspace);
  if (dirs.length === 0) return null;
  const files = indexedFiles(dirs);
  if (files > DEAD_CHECK_MAX_FILES) {
    return { label: `dead:check: ${files} files in ${dirs.join(", ")} exceed the ${DEAD_CHECK_MAX_FILES}-file local budget, deferred to CI`, deferred: true };
  }
  return { label: "dead:check", cmd: "node", args: ["scripts/dead-code-check.mjs", `--paths=${dirs.join(",")}`], env: { BASE_REF: base } };
}

const pnpmRun = (script) => ({ label: script, cmd: "pnpm", args: ["run", script] });

/**
 * Every ci.yml `run:` step, matched by job and by its command (a string matches the whole command or its leading
 * words). A `label` names the planCommands step that mirrors it; any other disposition says why there is none.
 * verify-changed-coverage.test.mjs fails on a step no row matches and on a labelled row the plan never runs.
 */
export const CI_COVERAGE = [
  { job: ["validate", "dag-check", "perf", "test-shard"], run: "pnpm install --frozen-lockfile", disposition: "setup", reason: "the checkout is installed already" },
  { job: "validate", run: "pnpm env:doctor", disposition: "local", label: "env:doctor" },
  { job: ["validate", "dag-check", "perf", "test-shard"], run: "pnpm build", disposition: "local", label: "build" },
  { job: "validate", run: "pnpm egress:scan range", disposition: "covered-by", reason: "the pre-push hook that prepare installs scans the pushed range" },
  { job: "validate", run: "pnpm merge:lint", disposition: "local", label: "merge:lint" },
  { job: "validate", run: "pnpm sidecar:finds", disposition: "local", label: "sidecar:finds" },
  { job: "validate", run: "pnpm typecheck", disposition: "local", label: "typecheck" },
  { job: "validate", run: "pnpm lint", disposition: "local", label: "lint" },
  { job: ["validate", "test-shard"], run: /apt-get install|dpkg -i|ImageVersion|playwright-core/, disposition: "setup", reason: "test-runner tooling, not a check" },
  { job: "validate", run: "pnpm test:scope", disposition: "local-subset", label: "vitest related", reason: "the full reverse closure can pass the 600 s cap; CI stays the authority" },
  { job: "test-shard", run: /^pnpm exec vitest run .*--shard=/, disposition: "ci-only", reason: "main's full suite in shards; a pull request runs the scoped pnpm test:scope instead" },
  { job: "validate", run: "pnpm capabilities:check", disposition: "local", label: "capabilities:check" },
  { job: "validate", run: "pnpm metrics:check", disposition: "local", label: "metrics:check" },
  { job: "validate", run: /sunset-manifest\.mjs check/, disposition: "ci-only", reason: "clones agent-chat over the network and only warns" },
  { job: "validate", run: "pnpm docs:build", disposition: "local", label: "docs:build" },
  { job: "validate", run: "pnpm changeset status", disposition: "local", label: "changeset status" },
  { job: "validate", run: "pnpm index-version:check", disposition: "local", label: "index-version:check" },
  { job: "dag-check", run: /INDEX_VERSION|codewatch-summary\.mjs/, disposition: "setup", reason: "cache key and report summary, not a check" },
  { job: "dag-check", run: /^pnpm dag:check:graph /, disposition: "separate-gate", reason: "pnpm dag:check, about 200 s seeded, runs beside verify:changed" },
  { job: "dag-check", run: /^pnpm dead:check /, disposition: "local-scoped", label: "dead:check", reason: "indexes only the touched packages, and defers past a 600-file budget to CI" },
  { job: "dag-check", run: "pnpm lint:types", disposition: "local-scoped", label: "lint:types", reason: "scoped by lintTypesScope over CI's test-scope graph" },
  { job: "perf", run: "pnpm vitest run --project perf", disposition: "ci-only", reason: "timing budgets need a runner with no other test load, so a local run would not be the authority" },
  { job: "hub-compose", run: /[\s\S]/, disposition: "ci-only", reason: "needs Docker; CI already scopes the job by path" },
];

/**
 * The CI_COVERAGE steps in ci.yml order, each argv for spawnSync with optional env. The cheap checks run on every
 * change: a trigger list that misses an input fails silently, and only CI catches it. LOC runs in-process after the
 * build, which produces the code-graph dist it reads.
 */
export function planCommands({ base, changed, workspace, hasTimeout, spool, flakeClasses = NO_FLAKE_CLASSES, indexedFiles = () => 0 }) {
  if (changed.length === 0) return [];
  return [
    pnpmRun("env:doctor"),
    pnpmRun("build"),
    { label: LOC_LABEL, inProcess: true },
    pnpmRun("merge:lint"),
    pnpmRun("sidecar:finds"),
    pnpmRun("typecheck"),
    pnpmRun("lint"),
    vitestCommand(changed, workspace, hasTimeout, spool),
    flakeRepeatStep(changed, flakeClasses, hasTimeout),
    pnpmRun("capabilities:check"),
    pnpmRun("metrics:check"),
    pnpmRun("docs:build"),
    { label: "changeset status", cmd: "pnpm", args: ["exec", "changeset", "status", `--since=${base}`] },
    { ...pnpmRun("index-version:check"), env: { BASE_REF: base } },
    deadCheckCommand(changed, workspace, base, indexedFiles),
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

// The files under `dirs` the indexer would read, tracked or not.
const indexedFiles = (dirs) =>
  gitLines(["ls-files", "--cached", "--other", "--exclude-standard", "--", ...dirs]).filter((path) => INDEXED_EXT.test(path)).length;

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

/** How a finished step is reported: a kill by the vitest cap is a timeout, never a test failure. */
export function describeOutcome(step, status) {
  if (status === 0) return { ok: true };
  if (status === TIMEOUT_EXIT_STATUS && step.cmd === "timeout") {
    return { ok: false, message: `${step.label} timed out after ${VITEST_TIMEOUT_SECONDS} s (no test failed; CI is the authority)` };
  }
  return { ok: false, message: `${step.label} failed` };
}

// Output is captured so the guard can see an unhandled-errors banner, then echoed so the run still reads as usual.
function runVitestOnce(step, files) {
  const result = spawnSync(step.cmd, [...step.prefix, ...files], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...step.env },
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function runFlakeStep(step) {
  const verdict = repeatGuard({ targets: step.targets, repeats: step.repeats, run: (files) => runVitestOnce(step, files) });
  return { ok: verdict.ok, message: `${FLAKE_LABEL} failed on ${verdict.message}` };
}

async function runStep(step, changed) {
  if (step.deferred) return { ok: true };
  if (step.flake) return runFlakeStep(step);
  if (step.inProcess) return { ok: await locPasses(changed), message: `${step.label} failed` };
  const { cmd, args, env } = step;
  const { status } = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  return describeOutcome(step, status);
}

async function main() {
  const base = process.env.VERIFY_CHANGED_BASE || process.argv[2] || DEFAULT_BASE;
  const changed = changedFiles(base);
  const plan = planCommands({ base, changed, workspace: readWorkspace(ROOT), hasTimeout: hasTimeout(), spool: timingSpool(), flakeClasses: loadFlakeClasses(FLAKE_CLASSES_PATH), indexedFiles });
  if (plan.length === 0) console.log(`verify:changed: nothing changed against ${base}`);
  let failed = false;
  for (const step of plan) {
    console.log(`verify:changed: ${step.label}`);
    const outcome = await runStep(step, changed);
    if (outcome.ok) continue;
    console.error(`verify:changed: ${outcome.message}`);
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
