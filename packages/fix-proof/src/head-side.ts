import * as fs from "node:fs";
import * as path from "node:path";
import { parseFixProofConfig, type FixProofConfig } from "./config.js";
import { git, messageOf, readConfig, RunError, withContext, type Context } from "./context.js";
import type { Exec } from "./exec.js";
import { compileGlobs } from "./glob.js";
import { baselineOf, classifyHeadRun, passingOf, reduceHeadRun, type BaselinePassing, type HeadFailure, type HeadOutcome } from "./head-classify.js";
import { built, DEFAULT_MUTANTS_BUDGET_MS, mutated, owningPackage, rebuildOf, writeInTree, type MutantTree } from "./mutant-side.js";
import { checkMutation, type HeadMutation } from "./mutation.js";
import type { TestStatus } from "./report.js";
import { addTree, prepare, testReport, withSandbox } from "./side.js";
import { readBlob } from "./spec-read.js";

/** Keeps a caught mutant's evidence small; the outcome is read from every failure before the list is cut. */
export const MAX_HEAD_FAILURES = 50;

export interface ExecHeadMutantsOptions {
  repo: string;
  /** A sha or ref; the worktree is detached at it. */
  head: string;
  mutations: readonly HeadMutation[];
  budgetMs?: number;
  sandboxUser?: string;
  exec?: Exec;
}

export interface HeadMutantRun {
  name: string;
  file: string;
  /** The owning package; null means the whole-repo build and test globs. */
  package: string | null;
  built: boolean;
  /** Absent when the mutant did not build or did not apply. */
  outcome?: HeadOutcome;
  /** Baseline-passing tests that failed, at most MAX_HEAD_FAILURES. */
  failed?: HeadFailure[];
  /** Why the mutation never applied: a refused target, a find not exactly once at head, or a package with no tests. */
  error?: string;
}

export interface HeadMutantsReport {
  /** The resolved sha, or the ref as given when it did not resolve. */
  head: string;
  /** Test files run, by package; "." stands for a null package. */
  suites: Record<string, string[]>;
  baseline: Array<{ test: string; file: string; status: TestStatus }>;
  runs: HeadMutantRun[];
  /** Mutation names never run because the budget ran out or the run failed first; never classified. */
  unrun: string[];
  wallMs: number;
  builds: number;
  error?: string;
}

interface HeadTree extends MutantTree {
  report: HeadMutantsReport;
}

const WHOLE_REPO = ".";

async function configAt(ctx: Context, head: string): Promise<FixProofConfig> {
  const parsed = parseFixProofConfig(await readConfig(ctx, head));
  if (!parsed.ok) throw new RunError(parsed.error);
  return parsed.config;
}

async function suiteOf(ctx: Context, head: string, pkg: string | null, config: FixProofConfig): Promise<string[]> {
  const pathspec = pkg === null ? [] : ["--", pkg];
  const files = (await git(ctx, ["ls-tree", "-r", "--name-only", head, ...pathspec], `listing ${pkg ?? "the repo"}`)).split("\n");
  return files.filter((file) => file !== "" && compileGlobs(config.tests)(file)).sort();
}

async function groupByPackage(ctx: Context, head: string, mutations: readonly HeadMutation[]): Promise<Map<string, HeadMutation[]>> {
  const groups = new Map<string, HeadMutation[]>();
  for (const mutation of mutations) {
    const pkg = (await owningPackage(ctx, head, mutation.file)) ?? WHOLE_REPO;
    groups.set(pkg, [...(groups.get(pkg) ?? []), mutation]);
  }
  return groups;
}

function passingIn(passing: BaselinePassing, suite: readonly string[]): BaselinePassing {
  return new Map(suite.map((file) => [file, passing.get(file) ?? new Set<string>()]));
}

async function rebuild(ht: HeadTree, file: string): Promise<boolean> {
  ht.report.builds += 1;
  return built(ht, await rebuildOf(ht, file));
}

/** Applies one mutation to the head text, rebuilds, runs its package's suite and restores the text; the caller rebuilds once per package. */
async function runOne(ht: HeadTree, mutation: HeadMutation, pkg: string, passing: BaselinePassing): Promise<HeadMutantRun> {
  const run: HeadMutantRun = { name: mutation.name, file: mutation.file, package: pkg === WHOLE_REPO ? null : pkg, built: false };
  const text = await readBlob(ht.ctx, ht.base, mutation.file);
  const checked = checkMutation(mutation, text, ht.config, "head");
  if (!checked.ok || text === null) return { ...run, error: checked.ok ? `${mutation.file} is unreadable at head` : checked.error };
  const suite = ht.report.suites[pkg] ?? [];
  if (suite.length === 0) return { ...run, error: `no test file under ${pkg}` };
  writeInTree(ht.tree, mutation.file, mutated(text, mutation));
  try {
    run.built = await rebuild(ht, mutation.file);
    if (!run.built) return run;
    const report = await testReport(ht.ctx, ht.tree, suite, ht.command, `mutant-${ht.report.runs.length}`, ht.sandboxUser);
    const reduced = reduceHeadRun(report, passingIn(passing, suite));
    return { ...run, outcome: classifyHeadRun(reduced), failed: reduced.failed.slice(0, MAX_HEAD_FAILURES) };
  } finally {
    writeInTree(ht.tree, mutation.file, text);
  }
}

async function runPackage(ht: HeadTree, pkg: string, mutations: readonly HeadMutation[], passing: BaselinePassing): Promise<void> {
  let written: string | undefined;
  for (const mutation of mutations) {
    if (Date.now() >= ht.ctx.deadline) return;
    const run = await runOne(ht, mutation, pkg, passing);
    ht.report.runs.push(run);
    if (run.error === undefined) written = mutation.file;
  }
  // The next package's rebuild leaves this one's dist mutated, so one restore rebuild per package replaces one per mutant.
  if (written !== undefined && !(await rebuild(ht, written))) {
    throw new RunError(`head-mutants: rebuilding ${pkg} after restoring failed`);
  }
}

async function runAll(ht: HeadTree, groups: Map<string, HeadMutation[]>): Promise<void> {
  for (const pkg of groups.keys()) ht.report.suites[pkg] = await suiteOf(ht.ctx, ht.base, pkg === WHOLE_REPO ? null : pkg, ht.config);
  const union = [...new Set(Object.values(ht.report.suites).flat())].sort();
  const baseline = union.length === 0 ? null : await testReport(ht.ctx, ht.tree, union, ht.command, "baseline", ht.sandboxUser);
  ht.report.baseline = baselineOf(baseline, union);
  const passing = passingOf(ht.report.baseline);
  for (const [pkg, mutations] of groups) await runPackage(ht, pkg, mutations, passing);
}

async function runHead(ctx: Context, head: string, options: ExecHeadMutantsOptions, report: HeadMutantsReport): Promise<void> {
  report.head = head;
  const config = await configAt(ctx, head);
  const groups = await groupByPackage(ctx, head, options.mutations);
  const tree = await addTree(ctx, "head-mutants", head);
  const pnpm = fs.existsSync(path.join(tree, "pnpm-lock.yaml"));
  const command = await prepare(ctx, tree, "head-mutants", config);
  const ht: HeadTree = { ctx, base: head, tree, command, config, pnpm, sandboxUser: options.sandboxUser, report };
  await (options.sandboxUser === undefined ? runAll(ht, groups) : withSandbox(ctx, tree, options.sandboxUser, () => runAll(ht, groups)));
}

/**
 * Runs generated mutations against head in a throwaway detached worktree, each against its owning package's tests, and
 * reports each outcome. The caller's checkout is never written. Never throws: a failure is `error`, and every mutation
 * not run by then, the budget's overrun included, is listed in `unrun` and never classified.
 */
export async function execHeadMutants(options: ExecHeadMutantsOptions): Promise<HeadMutantsReport> {
  const started = Date.now();
  const report: HeadMutantsReport = { head: options.head, suites: {}, baseline: [], runs: [], unrun: [], wallMs: 0, builds: 0 };
  const error = await withContext(
    { repo: options.repo, base: options.head, head: options.head, budgetMs: options.budgetMs ?? DEFAULT_MUTANTS_BUDGET_MS, exec: options.exec },
    async (ctx, shas) => runHead(ctx, shas.head, options, report).then(() => undefined),
    (_shas, message) => message,
  ).catch((caught: unknown) => `head-mutants: cleanup failed: ${messageOf(caught)}`);
  const ran = new Set(report.runs.map((run) => run.name));
  report.unrun = options.mutations.map((mutation) => mutation.name).filter((name) => !ran.has(name));
  report.wallMs = Date.now() - started;
  return error === undefined ? report : { ...report, error };
}
