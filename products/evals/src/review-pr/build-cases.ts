import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { CorpusRow } from "../corpus/index.js";
import { citesPath } from "../corpus/cited-paths.js";
import { caseHash, sha256Hex, suiteHash } from "../hash.js";
import { assertNoPrivate, engineeringInitiativeOf, filterPrivate, type ExclusionPolicy } from "../private/exclusion.js";
import { EvalCaseSchema, SuiteSpecSchema, type EvalCase, type SuiteSpec } from "../spec/index.js";
import { materializeBundle, type BundleGit } from "./bundle.js";
import { REVIEW_PR_CHECKS } from "./checks.js";
import { CONTROL_KINDS, plantDefect, type ControlKind, type PlantedDefect } from "./controls.js";

const run = promisify(execFile);
const REVIEW_PR_UNIT = { id: "review-pr", version: "1.0.0" } as const;
const DESCRIPTION_CHARS = 200;

type CaseKind = "defect" | "clean" | "control";

interface BuildOptions {
  outDir: string;
  policy: ExclusionPolicy;
  /** The local clone for `owner/repo`; a row whose repo has none is skipped as `no-clone`. */
  gitFor(repo: string): BundleGit | undefined;
  mainRef?: string;
  controls?: number;
  seed?: string;
}

export interface BuildManifest {
  schema: "titan.review-pr-cases/v1";
  suite: string;
  counts: Record<CaseKind, number>;
  /** Rows that yield no case: labels other than caught and clean, a missing clone, or no defect path. */
  skipped: Record<string, number>;
  excluded: Record<string, number>;
}

interface Draft {
  id: string;
  kind: CaseKind;
  repo: string;
  heads: Heads;
  taskInitiative: string | null;
  body: EvalCase;
}

interface Heads {
  repo: string;
  pr: number;
  head: string;
  base: string;
}

interface BuildContext extends Required<Omit<BuildOptions, "policy" | "gitFor">> {
  gitFor: BuildOptions["gitFor"];
  skipped: Record<string, number>;
}

const text = (buffer: Buffer): string => buffer.toString("utf8").trim();
const repoSlug = (repo: string): string => repo.slice(repo.lastIndexOf("/") + 1).toLowerCase().replace(/[^a-z0-9]+/g, "-");
const caseId = (heads: Heads, kind: string): string => `${repoSlug(heads.repo)}-pr${heads.pr}-${kind}-${heads.head.slice(0, 10)}`;
const bump = (counts: Record<string, number>, key: string): void => void (counts[key] = (counts[key] ?? 0) + 1);

/** A seeded hash, so a case keeps its split across rebuilds and a new seed reshuffles them all. */
function splitOf(seed: string, id: string): EvalCase["split"] {
  const draw = parseInt(sha256Hex(`${seed}\0${id}`).slice(0, 8), 16) / 2 ** 32;
  return draw < 0.6 ? "dev" : draw < 0.8 ? "validation" : "holdout";
}

/** `initiative/ID` names its initiative; a bare id is joined only through the engineering prefix table. */
function taskInitiativeOf(task: string | null): string | null {
  if (task === null) return null;
  const slash = task.indexOf("/");
  if (slash > 0) return task.slice(0, slash);
  return engineeringInitiativeOf(task) ?? task.split("-")[0] ?? task;
}

/** Refuses an out dir inside any git work tree, so a private case can never be committed by accident. */
async function assertOutsideWorkTree(outDir: string): Promise<void> {
  let probe = resolve(outDir);
  while (!existsSync(probe)) probe = dirname(probe);
  const inside = await run("git", ["-C", probe, "rev-parse", "--is-inside-work-tree"]).then(
    ({ stdout }) => stdout.trim() === "true",
    () => false,
  );
  if (inside) throw new Error(`--out ${outDir} is inside a git work tree; private cases must be written outside every repo`);
}

/** A head merged with a merge commit is its own merge base with main, so its base is the merge's first parent. */
async function baseOf(git: BundleGit, row: CorpusRow, mainRef: string): Promise<string> {
  const base = text(await git.git(["merge-base", mainRef, row.head]));
  if (base !== row.head || row.mergeSha === null) return base;
  return text(await git.git(["rev-parse", `${row.mergeSha}^1`]));
}

/** Gold defect paths: the paths the review cited that the next head changed. */
async function defectPaths(git: BundleGit, row: CorpusRow): Promise<string[]> {
  if (row.nextHead === null) return [];
  const changed = text(await git.git(["diff", "--name-only", row.head, row.nextHead])).split("\n").filter(Boolean);
  return changed.filter((path) => row.citedPaths.some((cited) => citesPath(cited, path))).sort();
}

function describeDefect(findings: string | null, paths: readonly string[]): string {
  const lines = (findings ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const line = lines.find((candidate) => paths.some((path) => candidate.includes(path.slice(path.lastIndexOf("/") + 1)))) ?? lines[0] ?? "";
  return line.slice(0, DESCRIPTION_CHARS);
}

function historyCase(context: BuildContext, heads: Heads, kind: "defect" | "clean", expected: unknown, ref: string): EvalCase {
  const id = caseId(heads, kind);
  return EvalCaseSchema.parse({
    schema: "titan.case/v1",
    id,
    unit: REVIEW_PR_UNIT,
    input: { repo: heads.repo, pr: heads.pr, head: heads.head, base: heads.base },
    fixture: { kind: "repo", repo: heads.repo, sha: heads.head },
    expected,
    split: splitOf(context.seed, id),
    tags: ["review-pr", kind],
    provenance: { source: "history", ref, labelVersion: 1 },
    visibility: "private",
  });
}

async function draftOf(context: BuildContext, row: CorpusRow, kind: "defect" | "clean"): Promise<Draft | undefined> {
  const git = context.gitFor(row.repo);
  if (!git) return void bump(context.skipped, "no-clone");
  const heads = { repo: row.repo, pr: row.pr, head: row.head, base: await baseOf(git, row, context.mainRef) };
  const ref = `${row.runId}@${row.head}`;
  if (kind === "clean") return wrap(row, heads, "clean", historyCase(context, heads, "clean", { verdict: "MERGE", defects: [] }, ref));
  const paths = await defectPaths(git, row);
  if (paths.length === 0) return void bump(context.skipped, "no-defect-path");
  const defects = paths.map((path) => ({ path, description: describeDefect(row.findings, paths) }));
  return wrap(row, heads, "defect", historyCase(context, heads, "defect", { verdict: "FIX_FIRST", defects }, ref));
}

const wrap = (row: CorpusRow, heads: Heads, kind: CaseKind, body: EvalCase): Draft => ({ id: body.id, kind, repo: row.repo, heads, taskInitiative: taskInitiativeOf(row.task), body });

/** Clean gold is the final merged head of a PR, so only a PR's latest clean row counts. */
function latestCleanRows(rows: readonly CorpusRow[]): Set<CorpusRow> {
  const latest = new Map<string, CorpusRow>();
  for (const row of rows.filter((candidate) => candidate.label === "clean")) {
    const key = `${row.repo}#${row.pr}`;
    const held = latest.get(key);
    if (!held || held.verdictAt < row.verdictAt) latest.set(key, row);
  }
  return new Set(latest.values());
}

async function historyDrafts(context: BuildContext, rows: readonly CorpusRow[]): Promise<Draft[]> {
  const cleanHeads = latestCleanRows(rows);
  const drafts: Draft[] = [];
  for (const row of rows) {
    const kind = row.label === "caught" ? "defect" : cleanHeads.has(row) ? "clean" : undefined;
    const draft = kind ? await draftOf(context, row, kind) : bump(context.skipped, row.label === "clean" ? "superseded-clean" : row.label);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

/** The first file the head changed that can carry `kind`, read from the clone at the head. */
async function findPlant(git: BundleGit, heads: Heads, kind: ControlKind): Promise<PlantedDefect | undefined> {
  const changed = text(await git.git(["diff", "--name-only", "--diff-filter=d", heads.base, heads.head])).split("\n").filter(Boolean).sort();
  for (const path of changed) {
    const planted = plantDefect(kind, path, (await git.git(["show", `${heads.head}:${path}`])).toString("utf8"));
    if (planted) return planted;
  }
  return undefined;
}

/** The planted tree's diff, from git alone; `--no-index` exits 1 when the trees differ, which they always do. */
async function treeDiff(bundleDir: string): Promise<string> {
  const args = ["diff", "--no-index", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "base", "head"];
  const stdout = await run("git", args, { cwd: bundleDir, maxBuffer: 1024 * 1024 * 1024 }).then(
    ({ stdout: out }) => out,
    (error: { code?: number; stdout?: string }) => {
      if (error.code === 1 && error.stdout !== undefined) return error.stdout;
      throw error;
    },
  );
  return stdout.replace(/^(diff --git |--- |\+\+\+ )(.*)$/gm, (_line, lead: string, rest: string) => lead + rest.replace(/\ba\/base\//g, "a/").replace(/\bb\/head\//g, "b/"));
}

function walkFiles(dir: string, root = dir): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walkFiles(path, root) : [relative(root, path)];
    });
}

/** Every file's path and content hash, so a tree fixture changes hash when any planted byte does. */
export function treeDigest(dir: string): string {
  return sha256Hex(walkFiles(dir).map((path) => `${path}\0${sha256Hex(readFileSync(join(dir, path)))}`).join("\n"));
}

async function writeControlTree(git: BundleGit, heads: Heads, planted: PlantedDefect, dir: string): Promise<void> {
  const bundle = await materializeBundle(git, heads, dir);
  writeFileSync(join(bundle.head, planted.path), planted.text);
  writeFileSync(bundle.diff, await treeDiff(dir));
}

async function plantControl(context: BuildContext, clean: Draft, kind: ControlKind): Promise<Draft | undefined> {
  const git = context.gitFor(clean.repo);
  const planted = git && (await findPlant(git, clean.heads, kind));
  if (!git || !planted) return undefined;
  const id = caseId(clean.heads, `control-${kind}`);
  const path = `trees/${id}`;
  await writeControlTree(git, clean.heads, planted, join(context.outDir, path));
  const body = EvalCaseSchema.parse({
    ...clean.body,
    id,
    fixture: { kind: "tree", path, treeSha256: treeDigest(join(context.outDir, path)) },
    expected: { verdict: "FIX_FIRST", defects: [{ path: planted.path, line: planted.line, description: planted.description }] },
    split: splitOf(context.seed, id),
    tags: ["review-pr", "control", kind],
    provenance: { source: "synthetic", ref: `planted:${kind}:${clean.id}`, labelVersion: 1 },
  });
  return { ...clean, id, kind: "control", body };
}

/** Kinds rotate, and each clean head carries a kind at most once; heads are taken in seeded order. */
async function plantControls(context: BuildContext, cleans: readonly Draft[]): Promise<Draft[]> {
  const order = [...cleans].sort((left, right) => (seededKey(context, left) < seededKey(context, right) ? -1 : 1));
  const controls: Draft[] = [];
  const used = new Set<string>();
  for (let n = 0; n < context.controls; n++) {
    const kind = CONTROL_KINDS[n % CONTROL_KINDS.length] ?? CONTROL_KINDS[0];
    const control = await firstPlantable(context, order, kind, used, n);
    if (!control) throw new Error(`only ${controls.length} of ${context.controls} planted controls could be built: no clean head left can carry ${kind}`);
    controls.push(control);
  }
  return controls;
}

const seededKey = (context: BuildContext, draft: Draft): string => sha256Hex(`${context.seed}\0control\0${draft.id}`);

async function firstPlantable(context: BuildContext, order: readonly Draft[], kind: ControlKind, used: Set<string>, start: number): Promise<Draft | undefined> {
  const at = order.length === 0 ? 0 : start % order.length;
  for (const clean of [...order.slice(at), ...order.slice(0, at)]) {
    const key = `${clean.id}:${kind}`;
    if (used.has(key)) continue;
    used.add(key);
    const control = await plantControl(context, clean, kind);
    if (control) return control;
  }
  return undefined;
}

function suiteOf(hashes: readonly string[]): SuiteSpec {
  return SuiteSpecSchema.parse({
    schema: "titan.suite/v1",
    unit: REVIEW_PR_UNIT,
    id: "review-pr-private",
    version: "1.0.0",
    cases: [...hashes].sort(),
    checks: REVIEW_PR_CHECKS,
    trials: 3,
  });
}

function writeOutput(outDir: string, cases: readonly Draft[], manifest: Omit<BuildManifest, "suite">): BuildManifest {
  mkdirSync(join(outDir, "cases"), { recursive: true });
  for (const draft of cases) writeFileSync(join(outDir, "cases", `${draft.id}.json`), `${JSON.stringify(draft.body, null, 2)}\n`);
  const suite = suiteOf(cases.map((draft) => caseHash(draft.body)));
  writeFileSync(join(outDir, "suite.json"), `${JSON.stringify(suite, null, 2)}\n`);
  const full: BuildManifest = { ...manifest, suite: suiteHash(suite) };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

function assertFreshOut(outDir: string): void {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new Error(`--out ${outDir} is not empty; build into a fresh directory`);
}

/**
 * Turns outcome-corpus rows into private review-pr cases: caught heads as FIX_FIRST with the defect path, a PR's
 * final clean head as MERGE, and planted controls on clean heads. Private cases are filtered before planting and
 * asserted absent again before anything is written.
 */
export async function buildReviewPrCases(rows: readonly CorpusRow[], options: BuildOptions): Promise<BuildManifest> {
  await assertOutsideWorkTree(options.outDir);
  assertFreshOut(options.outDir);
  const context: BuildContext = { outDir: options.outDir, gitFor: options.gitFor, mainRef: options.mainRef ?? "origin/main", controls: options.controls ?? 6, seed: options.seed ?? "review-pr", skipped: {} };
  const { kept, excluded } = filterPrivate(await historyDrafts(context, rows), options.policy);
  const controls = await plantControls(context, kept.filter((draft) => draft.kind === "clean"));
  const cases = [...kept, ...controls];
  assertNoPrivate(cases, options.policy);
  const counts = { defect: 0, clean: 0, control: 0 };
  for (const draft of cases) counts[draft.kind] += 1;
  return writeOutput(options.outDir, cases, { schema: "titan.review-pr-cases/v1", counts, skipped: context.skipped, excluded: { ...excluded } });
}
