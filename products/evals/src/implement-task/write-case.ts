import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planFixProof, type FixProofPlan } from "@titan-design/fix-proof";
import { sha256Hex } from "../hash.js";
import { assertNoPrivate, filterPrivate, type ExclusionPolicy } from "../private/exclusion.js";
import { assertOutsideWorkTree } from "../private/out-dir.js";
import { splitOf } from "../review-pr/build-cases.js";
import type { BundleGit } from "../review-pr/bundle.js";
import { EvalCaseSchema, type EvalCase } from "../spec/index.js";
import { assertNoLaterHistory, seedWorkspace, writeBaseTree } from "./workspace.js";

export const IMPLEMENT_TASK_UNIT = { id: "implement-task", version: "1.0.0" } as const;
const FIX_PROOF_CONFIG = ".github/fix-proof.json";

/** One accepted pull request, read from the corpus: the task brief and the commits around its merge. */
export interface ImplementTaskSource {
  repo: string;
  pr: number;
  baseSha: string;
  mergeSha: string;
  brief: string;
  taskInitiative: string | null;
  cls: string;
}

interface WriteOptions {
  outDir: string;
  policy: ExclusionPolicy;
  /** The local clone for `owner/repo`; the writer never fetches, so a source with no clone is an error. */
  gitFor(repo: string): BundleGit | undefined;
  seed?: string;
}

interface WriteResult {
  cases: EvalCase[];
  excluded: Record<string, number>;
}

interface Draft {
  id: string;
  repo: string;
  taskInitiative: string | null;
  source: ImplementTaskSource;
  plan: FixProofPlan;
  body: EvalCase;
}

const repoSlug = (repo: string): string => repo.slice(repo.lastIndexOf("/") + 1).toLowerCase().replace(/[^a-z0-9]+/g, "-");
const implementCaseId = (source: ImplementTaskSource): string => `${repoSlug(source.repo)}-pr${source.pr}-implement-${source.mergeSha.slice(0, 10)}`;

const show = async (port: BundleGit, sha: string, path: string): Promise<Buffer> => port.git(["show", `${sha}:${path}`]);

async function readConfig(port: BundleGit, sha: string): Promise<string | null> {
  const listed = (await port.git(["ls-tree", "--name-only", sha, "--", FIX_PROOF_CONFIG])).toString("utf8").trim();
  return listed === "" ? null : (await show(port, sha, FIX_PROOF_CONFIG)).toString("utf8");
}

/** The same plan Shepherd's fix-proof check derives, so a hidden test is exactly a test the accepted diff added or changed. */
export async function planHiddenTests(port: BundleGit, baseSha: string, mergeSha: string): Promise<FixProofPlan> {
  const nameStatus = (await port.git(["diff", "-M", "--name-status", baseSha, mergeSha])).toString("utf8");
  const planned = planFixProof({ nameStatus, baseConfig: await readConfig(port, baseSha), headConfig: await readConfig(port, mergeSha) });
  if (!planned.ok) throw new Error(`fix-proof plan for ${baseSha}..${mergeSha}: ${planned.error}`);
  return planned.plan;
}

async function filesAtMerge(port: BundleGit, source: ImplementTaskSource, paths: readonly string[]) {
  return Promise.all(paths.map(async (path) => ({ path, sha256: sha256Hex(await show(port, source.mergeSha, path)), sourcePr: source.pr, sourceSha: source.mergeSha })));
}

function caseBody(source: ImplementTaskSource, seed: string, expected: unknown): EvalCase {
  const id = implementCaseId(source);
  return EvalCaseSchema.parse({
    schema: "titan.case/v1",
    id,
    unit: IMPLEMENT_TASK_UNIT,
    input: { repo: source.repo, pr: source.pr, base: source.baseSha, brief: source.brief },
    expected,
    split: splitOf(seed, id),
    tags: ["implement-task", source.cls],
    provenance: { source: "history", ref: `${source.repo}#${source.pr}@${source.mergeSha}`, labelVersion: 3 },
    visibility: "private",
  });
}

async function draftOf(port: BundleGit, source: ImplementTaskSource, seed: string): Promise<Draft> {
  const plan = await planHiddenTests(port, source.baseSha, source.mergeSha);
  const expected = { hiddenTests: await filesAtMerge(port, source, plan.tests), support: await filesAtMerge(port, source, plan.carried), overlayRemovals: plan.overlayRemovals };
  const body = caseBody(source, seed, expected);
  return { id: body.id, repo: source.repo, taskInitiative: source.taskInitiative, source, plan, body };
}

async function writeHidden(port: BundleGit, draft: Draft, outDir: string): Promise<void> {
  for (const path of [...draft.plan.tests, ...draft.plan.carried]) {
    const target = join(outDir, "hidden", draft.id, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await show(port, draft.source.mergeSha, path));
  }
}

/** Seeds a throwaway workspace from the written tree, so no case ships a fixture that leaks its own merge. */
async function proveNoHistory(treeDir: string, mergeSha: string): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "implement-task-seed-"));
  try {
    const workspace = join(scratch, "workspace");
    await seedWorkspace(treeDir, workspace);
    await assertNoLaterHistory(workspace, mergeSha);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function writeDraft(port: BundleGit, draft: Draft, outDir: string): Promise<EvalCase> {
  const commits = { base: draft.source.baseSha, merge: draft.source.mergeSha };
  const fixture = { kind: "tree" as const, ...(await writeBaseTree(port, commits, outDir, draft.id)) };
  await proveNoHistory(join(outDir, fixture.path), draft.source.mergeSha);
  await writeHidden(port, draft, outDir);
  const body = EvalCaseSchema.parse({ ...draft.body, fixture });
  mkdirSync(join(outDir, "cases"), { recursive: true });
  writeFileSync(join(outDir, "cases", `${draft.id}.json`), `${JSON.stringify(body, null, 2)}\n`);
  return body;
}

const portOf = (options: WriteOptions, repo: string): BundleGit => {
  const port = options.gitFor(repo);
  if (!port) throw new Error(`no local clone for ${repo}`);
  return port;
};

/**
 * Writes each accepted pull request as a private implement-task case: `cases/<id>.json`, the merge's first-parent
 * tree under `trees/<id>` and the hidden tests under `hidden/<id>`, beside the tree and never inside it. Private
 * sources are filtered before any file is written and asserted absent again before the first write.
 */
export async function writeImplementTaskCases(sources: readonly ImplementTaskSource[], options: WriteOptions): Promise<WriteResult> {
  await assertOutsideWorkTree(options.outDir);
  const seed = options.seed ?? "implement-task";
  const { kept, excluded } = filterPrivate(sources.map((source) => ({ id: implementCaseId(source), repo: source.repo, taskInitiative: source.taskInitiative, body: source })), options.policy);
  const drafts: Draft[] = [];
  for (const { body: source } of kept) drafts.push(await draftOf(portOf(options, source.repo), source, seed));
  assertNoPrivate(drafts, options.policy);
  const cases: EvalCase[] = [];
  for (const draft of drafts) cases.push(await writeDraft(portOf(options, draft.repo), draft, options.outDir));
  return { cases, excluded: { ...excluded } };
}
