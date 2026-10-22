import { git, type Context, type Shas } from "./context.js";
import { compileGlobs } from "./glob.js";
import { testFileOfSpec, type SpecUnderTest } from "./mutant-classify.js";
import { checkMutation, parseMutationSpec, type MutationSpec } from "./mutation.js";
import type { FixProofPlan } from "./plan.js";

/** A spec that does not parse, fails its merge-base check or has no single test beside it. */
export class SpecError extends Error {}

// A blob that is not a regular file (a symlink or a gitlink) reads as missing, so a mutation never writes through one.
export async function readBlob(ctx: Context, sha: string, file: string): Promise<string | null> {
  const listed = await git(ctx, ["ls-tree", sha, "--", file], `listing ${file}`);
  if (!/^100(?:644|755) blob /.test(listed)) return null;
  return git(ctx, ["show", `${sha}:${file}`], `reading ${file}`);
}

async function headFilesBeside(ctx: Context, head: string, spec: string): Promise<string[]> {
  const dir = spec.includes("/") ? spec.slice(0, spec.lastIndexOf("/")) : "";
  const pathspec = dir === "" ? [] : ["--", dir];
  return (await git(ctx, ["ls-tree", "-r", "--name-only", head, ...pathspec], "listing the spec's directory")).split("\n").filter(Boolean);
}

async function readSpecAtHead(ctx: Context, head: string, path: string): Promise<MutationSpec> {
  const text = await readBlob(ctx, head, path);
  if (text === null) throw new SpecError(`${path}: not a regular file at head`);
  const parsed = parseMutationSpec(text);
  if (!parsed.ok) throw new SpecError(`${path}: ${parsed.error}`);
  return parsed.spec;
}

/** Reads one spec at head and pairs it with its test file, without the merge-base check. */
async function readPairedSpec(ctx: Context, plan: FixProofPlan, head: string, path: string): Promise<SpecUnderTest> {
  const spec = await readSpecAtHead(ctx, head, path);
  const testFile = testFileOfSpec(path, await headFilesBeside(ctx, head, path), compileGlobs(plan.config.tests));
  if (testFile === null) throw new SpecError(`${path}: no single test file sits beside it`);
  return { path, testFile, mutations: spec.mutations };
}

/** Reads one spec at head, pairs it with its test file and checks every mutation against the text at `sha`. */
async function readSpecAgainst(ctx: Context, plan: FixProofPlan, head: string, path: string, against: { sha: string; at: string }): Promise<SpecUnderTest> {
  const spec = await readPairedSpec(ctx, plan, head, path);
  for (const mutation of spec.mutations) {
    const checked = checkMutation(mutation, await readBlob(ctx, against.sha, mutation.file), plan.config, against.at);
    if (!checked.ok) throw new SpecError(`${path}: ${checked.error}`);
  }
  return spec;
}

/**
 * Every spec the plan names, read and checked against head. A diff with source in it may mutate code the merge base
 * lacks, so the merge-base check would refuse a sound spec there; at head every mutation's code exists, so its target
 * and an exactly-once find still catch a spec no later test-only diff could run.
 */
export async function readSpecsAtHead(ctx: Context, plan: FixProofPlan, head: string): Promise<SpecUnderTest[]> {
  const specs: SpecUnderTest[] = [];
  for (const path of plan.mutations) specs.push(await readSpecAgainst(ctx, plan, head, path, { sha: head, at: "head" }));
  return specs;
}

/** Every spec the plan names, read and checked in plan order; the judge and the mutants side share this one reading. */
export async function readSpecs(ctx: Context, plan: FixProofPlan, shas: Shas): Promise<SpecUnderTest[]> {
  const specs: SpecUnderTest[] = [];
  for (const path of plan.mutations) specs.push(await readSpecAgainst(ctx, plan, shas.head, path, { sha: shas.base, at: "the merge base" }));
  return specs;
}
