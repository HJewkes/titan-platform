import { sha256Hex } from "../../hash.js";
import type { CorpusV3Row } from "../../implement-task/select.js";
import { engineeringInitiativeOf } from "../../private/exclusion.js";
import { scrubBrief } from "./brief.js";
import type { CorpusSources, MainMerge, NumstatLine, Registration, TaskFile } from "./sources.js";

export const KINDS = ["correctness", "feature", "refactor"] as const;
const SIZES = ["S", "M"] as const;
const PKG_GROUPS = ["factory", "explainer", "console", "other"] as const;
const MAX_CHANGED_LINES = 600;

type Kind = (typeof KINDS)[number];
type Size = (typeof SIZES)[number] | "L";
type PkgGroup = (typeof PKG_GROUPS)[number];

export interface ImplementCandidate {
  row: CorpusV3Row;
  taskId: string;
  kind: Kind;
  size: (typeof SIZES)[number];
  pkg: string;
  pkgGroup: PkgGroup;
  mergedAt: string;
  changedLines: number;
  nonTestLines: number;
}

interface Skipped {
  pr: number;
  reason: string;
}

export interface Corpus {
  eligible: ImplementCandidate[];
  skipped: Skipped[];
}

export interface CorpusOptions {
  /** ISO date; a PR merged before it is left out. */
  mergedSince: string;
  repo: string;
}

const TEST_FILE = /\.test\./;
const NOT_SOURCE = /\.test\.|\.md$|\.changeset\/|CHANGELOG|\.json$/;
const PKG_GROUP_OF: Readonly<Record<string, PkgGroup>> = { "products/factory": "factory", "products/explainer": "explainer", "apps/console": "console" };

/** The task's own estimate when it has one; changed lines stand in for a task that was never estimated. */
export function sizeOf(estimate: number | null, changedLines: number): Size {
  if (estimate !== null) return estimate <= 1.5 ? "S" : estimate <= 3 ? "M" : "L";
  return changedLines <= 150 ? "S" : changedLines <= 400 ? "M" : "L";
}

const pkgOf = (path: string): string | undefined => (/^(packages|products|apps)\//.test(path) ? path.split("/").slice(0, 2).join("/") : undefined);
const linesOf = (lines: readonly NumstatLine[]): number => lines.reduce((sum, line) => sum + (line.changed ?? 0), 0);

interface DiffFacts {
  hasTest: boolean;
  changedLines: number;
  nonTestLines: number;
  pkgs: string[];
}

function diffFacts(numstat: readonly NumstatLine[]): DiffFacts {
  const source = numstat.filter((line) => !NOT_SOURCE.test(line.path));
  const pkgs = [...new Set(numstat.flatMap((line) => pkgOf(line.path) ?? []))];
  return { hasTest: numstat.some((line) => TEST_FILE.test(line.path)), changedLines: linesOf(numstat), nonTestLines: source.length === 0 ? 0 : linesOf(source), pkgs };
}

/** Row checks that need no git call. */
function rowSkip(merge: MainMerge, kind: string, task: TaskFile, options: CorpusOptions): string | undefined {
  if (merge.mergedAt.slice(0, 10) < options.mergedSince) return "merged-before-window";
  if (!(KINDS as readonly string[]).includes(kind)) return `kind-${kind}`;
  if (task.doneWhen === null) return "no-done-when";
  return undefined;
}

function diffSkip(facts: DiffFacts, sourceFiles: number): string | undefined {
  if (!facts.hasTest) return "no-test-change";
  if (sourceFiles === 0) return "test-only";
  if (facts.changedLines > MAX_CHANGED_LINES) return "over-600-lines";
  if (facts.pkgs.length !== 1) return "not-one-package";
  return undefined;
}

type Joined = { merge: MainMerge; registration: Registration; taskId: string; task: TaskFile };

/** The registration's main commit and task file, or why one is missing. */
function joinSources(registration: Registration, mergeOf: ReadonlyMap<number, MainMerge>, sources: CorpusSources): Joined | string {
  const merge = mergeOf.get(registration.pr);
  if (merge === undefined) return "not-on-main";
  const taskId = registration.task.slice(registration.task.lastIndexOf("/") + 1);
  if (!taskId.startsWith("TP-")) return "not-a-task";
  try {
    const task = sources.task(taskId);
    return task === undefined ? "no-task-file" : { merge, registration, taskId, task };
  } catch {
    return "task-file-unreadable";
  }
}

function corpusRow(joined: Joined, brief: string, repo: string): CorpusV3Row {
  const { merge, taskId, task, registration } = joined;
  const initiative = engineeringInitiativeOf(taskId) ?? "";
  return {
    case_id: `${repo}-pr${merge.pr}`,
    repo,
    pr_number: merge.pr,
    base_commit: merge.parent,
    merge_commit: merge.sha,
    class: registration.kind,
    n_tasks: 1,
    task_ids: [taskId],
    task: { id: taskId, initiative },
    title: task.title,
    brief_text: brief,
    follow_up_fixes: [],
  };
}

async function candidateOf(joined: Joined, sources: CorpusSources, options: CorpusOptions): Promise<ImplementCandidate | string> {
  const { merge, registration, task } = joined;
  const early = rowSkip(merge, registration.kind, task, options);
  if (early !== undefined) return early;
  const numstat = await sources.numstat(merge);
  const facts = diffFacts(numstat);
  const size = sizeOf(task.estimate, facts.changedLines);
  const skip = diffSkip(facts, numstat.filter((line) => !NOT_SOURCE.test(line.path)).length);
  if (skip !== undefined) return skip;
  if (size === "L") return "size-L";
  const scrubbed = scrubBrief({ title: task.title, doneWhen: task.doneWhen ?? "" }, { pr: merge.pr, mergeSha: merge.sha });
  if (!scrubbed.ok) return scrubbed.reason;
  const pkg = facts.pkgs[0] ?? "";
  const kind = registration.kind as Kind;
  return { row: corpusRow(joined, scrubbed.brief, options.repo), taskId: joined.taskId, kind, size, pkg, pkgGroup: PKG_GROUP_OF[pkg] ?? "other", mergedAt: merge.mergedAt, ...facts };
}

/** The latest registration per PR: a re-registration carries the kind Shepherd last ran it under. */
function latestByPr(registrations: readonly Registration[]): Registration[] {
  const byPr = new Map<number, Registration>();
  for (const registration of registrations) {
    const seen = byPr.get(registration.pr);
    if (seen === undefined || seen.createdAt <= registration.createdAt) byPr.set(registration.pr, registration);
  }
  return [...byPr.values()].sort((a, b) => a.pr - b.pr);
}

/** Joins Shepherd registrations to main's squash merges and their task files; every PR left out records why. */
export async function buildCorpus(sources: CorpusSources, options: CorpusOptions): Promise<Corpus> {
  const mergeOf = new Map((await sources.mainMerges()).map((merge) => [merge.pr, merge]));
  const corpus: Corpus = { eligible: [], skipped: [] };
  for (const registration of latestByPr(sources.registrations())) {
    const joined = joinSources(registration, mergeOf, sources);
    const outcome = typeof joined === "string" ? joined : await candidateOf(joined, sources, options);
    if (typeof outcome === "string") corpus.skipped.push({ pr: registration.pr, reason: outcome });
    else corpus.eligible.push(outcome);
  }
  return corpus;
}

const strataOrder = (): string[] => PKG_GROUPS.flatMap((pkg) => SIZES.flatMap((size) => KINDS.map((kind) => `${kind}/${size}/${pkg}`)));

/**
 * Seeded order within each kind x size x package stratum, then one from each stratum per round. Kind varies fastest,
 * so the first few candidates already span every kind.
 */
export function stratifiedQueue(candidates: readonly ImplementCandidate[], seed: string): ImplementCandidate[] {
  const draw = (candidate: ImplementCandidate): string => sha256Hex(`${seed}\0${candidate.row.case_id}`);
  const strata = strataOrder().map((key) =>
    candidates.filter((candidate) => `${candidate.kind}/${candidate.size}/${candidate.pkgGroup}` === key).sort((a, b) => draw(a).localeCompare(draw(b))),
  );
  const queue: ImplementCandidate[] = [];
  const rounds = Math.max(0, ...strata.map((stratum) => stratum.length));
  for (let round = 0; round < rounds; round += 1) {
    for (const stratum of strata) {
      const next = stratum[round];
      if (next !== undefined) queue.push(next);
    }
  }
  return queue;
}
