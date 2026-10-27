import * as fs from "node:fs";
import * as path from "node:path";
import type { FixProofConfig } from "./config.js";
import { git, messageOf, planDiffOnly, RunError, withContext, withSpecSiblings, type Context, type Shas } from "./context.js";
import type { SpecUnderTest } from "./mutant-classify.js";
import type { HeadMutation, Mutation } from "./mutation.js";
import { normalizeRelative } from "./paths.js";
import { testOnlyOf } from "./plan.js";
import { addTree, overlay, prepare, runInTree, testReport, withSandbox, type ExecSideOptions } from "./side.js";
import { readBlob, readSpecs, readSpecsAtHead, SpecError } from "./spec-read.js";
import { toolchainOf } from "./toolchain.js";
import { encodeError, encodeMutantsReport, encodeMutantsSkipped, type MutantRun } from "./transport.js";

/** Leaves headroom under the mutants job's 15-minute timeout; an overrun is an error marker, never a kill. */
export const DEFAULT_MUTANTS_BUDGET_MS = 13 * 60_000;
/** The mutants side writes its one combined report as `<out>/mutants.report`. */
export const MUTANTS_REPORT = "mutants";
/** Written beside the report only when a spec is refused; fix-proof-run.sh fails the mutants job on it. */
const MUTANTS_REFUSED = "mutants.refused";

export type ExecMutantsOptions = Omit<ExecSideOptions, "side">;

export interface Rebuild {
  script: string;
  args: string[];
}

export interface MutantTree {
  ctx: Context;
  base: string;
  tree: string;
  command: string;
  config: FixProofConfig;
  pnpm: boolean;
  sandboxUser: string | undefined;
}

export async function owningPackage(ctx: Context, base: string, file: string): Promise<string | null> {
  const segments = file.split("/").slice(0, -1);
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const dir = segments.slice(0, depth).join("/");
    if ((await git(ctx, ["ls-tree", "--name-only", base, "--", `${dir}/package.json`], `listing ${dir}`)).trim() !== "") return dir;
  }
  return null;
}

// Packages resolve through dist/, so a mutation is only seen once its own package is rebuilt; a pnpm workspace rebuilds
// just that package, anything else falls back to the full build.
export async function rebuildOf(mt: MutantTree, file: string): Promise<Rebuild> {
  const owner = mt.pnpm ? await owningPackage(mt.ctx, mt.base, file) : null;
  if (owner === null) return { script: mt.config.build ?? toolchainOf(mt.tree).build, args: [] };
  return { script: "pnpm --filter", args: [`./${owner}`, "run", "--if-present", "build"] };
}

// No sandboxed process outlives its call, so the tree cannot change between this check and the write it guards.
export function writeInTree(tree: string, file: string, text: string): void {
  const relative = normalizeRelative(file);
  if (relative === null) throw new RunError(`mutants: unsafe mutation path ${file}`);
  const target = path.join(tree, relative);
  if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) throw new RunError(`mutants: ${file} is not inside the tree`);
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_TRUNC);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new RunError(`mutants: ${file} is not a regular file`);
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

export function mutated(baseText: string, mutation: HeadMutation): string {
  const at = baseText.indexOf(mutation.find);
  return baseText.slice(0, at) + mutation.replace + baseText.slice(at + mutation.find.length);
}

export async function built(mt: MutantTree, rebuild: Rebuild): Promise<boolean> {
  return (await runInTree(mt.ctx, mt.tree, rebuild.script, rebuild.args, mt.sandboxUser)).status === 0;
}

/** Applies one mutation from the merge-base text, rebuilds, runs the spec's test file, then restores and rebuilds again. */
async function runMutant(mt: MutantTree, spec: SpecUnderTest, mutation: Mutation, index: number): Promise<MutantRun> {
  const baseText = await readBlob(mt.ctx, mt.base, mutation.file);
  if (baseText === null) throw new RunError(`mutants: ${mutation.file} is missing at the merge base`);
  const rebuild = await rebuildOf(mt, mutation.file);
  writeInTree(mt.tree, mutation.file, mutated(baseText, mutation));
  const run: MutantRun = { spec: spec.path, name: mutation.name, built: await built(mt, rebuild) };
  if (run.built) run.report = await testReport(mt.ctx, mt.tree, [spec.testFile], mt.command, `mutant-${index}`, mt.sandboxUser);
  writeInTree(mt.tree, mutation.file, baseText);
  if (!(await built(mt, rebuild))) throw new RunError(`mutants: rebuilding after restoring ${mutation.file} failed`);
  return run;
}

async function runAll(mt: MutantTree, specs: readonly SpecUnderTest[]): Promise<string> {
  const testFiles = [...new Set(specs.map((spec) => spec.testFile))];
  const baseline = await testReport(mt.ctx, mt.tree, testFiles, mt.command, "baseline", mt.sandboxUser);
  const runs: MutantRun[] = [];
  for (const spec of specs) {
    for (const mutation of spec.mutations) runs.push(await runMutant(mt, spec, mutation, runs.length));
  }
  return encodeMutantsReport({ baseline, runs });
}

interface Refusal {
  error?: string;
}

// A source diff's judge reads no spec, so there a git failure or timeout is a refusal too, or the specs would land unread.
async function orRefuse<T>(refusal: Refusal, read: () => Promise<T>, anyError = false): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (anyError || error instanceof SpecError) refusal.error = messageOf(error);
    throw error;
  }
}

async function runMutants(ctx: Context, shas: Shas, sandboxUser: string | undefined, refusal: Refusal): Promise<string> {
  const diffPlan = await planDiffOnly(ctx, shas);
  if (diffPlan.plan.mutations.length === 0) return encodeMutantsSkipped("no mutation spec in the diff");
  // Listing a spec's directory is reading the spec, so a failure there is refused on the same terms as readSpecs below.
  const plan = await orRefuse(refusal, () => withSpecSiblings(ctx, shas.head, diffPlan), !testOnlyOf(diffPlan.plan));
  if (!testOnlyOf(plan)) {
    // The judge never reads a source diff's specs, so without this a spec no later test-only diff could run lands unread.
    await orRefuse(refusal, () => readSpecsAtHead(ctx, plan, shas.head), true);
    return encodeMutantsSkipped(`the diff changes source: ${plan.source[0] ?? ""}`);
  }
  const specs = await orRefuse(refusal, () => readSpecs(ctx, plan, shas));
  const tree = await addTree(ctx, "mutants", shas.base);
  const pnpm = fs.existsSync(path.join(tree, "pnpm-lock.yaml"));
  // As on the base side, the merge base installs and builds before any head file lands in its tree.
  const command = await prepare(ctx, tree, "mutants", plan.config);
  await overlay(ctx, tree, shas.head, plan);
  const mt: MutantTree = { ctx, base: shas.base, tree, command, config: plan.config, pnpm, sandboxUser };
  return sandboxUser === undefined ? runAll(mt, specs) : withSandbox(ctx, tree, sandboxUser, () => runAll(mt, specs));
}

/**
 * Runs every declared mutation of a test-only diff against the merge base with the head's tests overlaid and writes one
 * `mutants.report`: a skipped marker with no spec or with source in the diff, an error marker on any failure, never a throw.
 * A spec that does not read, pair or check, source diff or not, also writes its reason to `mutants.refused`, which fails
 * the mutants job. With a sandbox user, every build and vitest call after the overlay runs inside the sandbox.
 */
export async function execMutants(options: ExecMutantsOptions): Promise<void> {
  const refusal: Refusal = {};
  const report = await withContext(
    { ...options, budgetMs: options.budgetMs ?? DEFAULT_MUTANTS_BUDGET_MS },
    (ctx, shas) => runMutants(ctx, shas, options.sandboxUser, refusal),
    (_shas, error) => encodeError(error),
  ).catch((error: unknown) => encodeError(`mutants: cleanup failed: ${messageOf(error)}`));
  try {
    fs.mkdirSync(options.out, { recursive: true });
    fs.writeFileSync(path.join(options.out, `${MUTANTS_REPORT}.report`), report);
    if (refusal.error !== undefined) fs.writeFileSync(path.join(options.out, MUTANTS_REFUSED), refusal.error);
  } catch {
    // The judge reads an absent report as a mutants error, so swallowing a write failure still fails closed.
  }
}
