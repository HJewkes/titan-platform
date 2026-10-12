import { ciVerdict, latestPerName, type PullRequest, type RepoSlug } from "@titan-design/github";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import type { FactoryHost } from "../host.js";
import type { CachedRuns, PrSnapshot } from "../workflows/pr-snapshot.js";
import type { Phase } from "./step-phase.js";
import type { Registration } from "./store.js";
import { rowOf, rowsWithRuns, runFinished, type RowWithRun } from "./watch-rows.js";
import type { ShepherdServices } from "./commands.js";

/** How far back a merge Shepherd made is still listed. */
export const MERGED_WINDOW_MS = 24 * 60 * 60_000;

/** `push` and `gh-write` name the writers that will feed rows in later slices; today only the first two are produced. */
type PrRowSource = "snapshot" | "merge-step" | "push" | "gh-write";

interface PrRowCi {
  head: string;
  state: "pending" | "green" | "red" | "none";
  /** Required contexts with no run on the head; empty when the run recorded no required list. */
  requiredMissing: string[];
  at: string;
}

/** One PR as Shepherd knows it; `ci` is present only when the snapshot already holds the head's checks. */
export interface PrRow {
  repo: RepoSlug;
  number: number;
  branch: string | null;
  headSha: string | null;
  base: string | null;
  state: "open" | "merged";
  mergedAt: string | null;
  mergeSha: string | null;
  title: string | null;
  body: string | null;
  draft: boolean;
  registered: boolean;
  runId?: string;
  phase?: Phase;
  ci?: PrRowCi;
  source: PrRowSource;
  at: string;
}

/** A registration with its run, loaded once per call. */
export interface ShepherdedRun {
  registration: Registration;
  run: WorkflowRun;
  phase: Phase;
  headSha: string | null;
}

export interface PrsSources {
  snapshot: Pick<PrSnapshot, "openList" | "cachedRuns">;
  /** Live runs and runs that finished inside the merged window. */
  shepherded: (since: number) => Promise<ShepherdedRun[]>;
  /** Every configured seat repo, listed even when no run is waiting in it. */
  seatRepos: () => readonly string[];
  now: () => number;
}

const MergeLanded = z.looseObject({ result: z.looseObject({ done: z.literal(true), mergeSha: z.string() }) });
const LandRules = z.looseObject({ result: z.looseObject({ base: z.string(), contexts: z.array(z.string()) }) });

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Open rows come from the snapshot's list, which costs no GitHub call while it is under one tick old, and concurrent
 * callers share one list read. Merged rows come from the merge step that landed them, so none needs a `getPr`.
 */
export async function shepherdPrs(sources: PrsSources, only?: RepoSlug): Promise<PrRow[]> {
  const since = sources.now() - MERGED_WINDOW_MS;
  const runs = (await sources.shepherded(since)).filter(({ registration }) => only === undefined || registration.repo === only.toLowerCase());
  const repos = only === undefined ? repoSet(sources.seatRepos(), runs) : [only.toLowerCase()];
  const open = await Promise.all(repos.map(async (repo) => openRows(sources.snapshot, repo, runs)));
  const listed = new Set(open.flat().map((row) => `${row.repo}#${row.number}`));
  const merged = runs.flatMap((entry) => mergedRow(entry, since) ?? []).filter((row) => !listed.has(`${row.repo}#${row.number}`));
  return [...open.flat(), ...merged];
}

function repoSet(seatRepos: readonly string[], runs: readonly ShepherdedRun[]): string[] {
  const live = runs.filter(({ run }) => run.completedAt === null).map(({ registration }) => registration.repo);
  return [...new Set([...seatRepos, ...live].map((repo) => repo.toLowerCase()))].sort();
}

async function openRows(snapshot: PrsSources["snapshot"], repo: RepoSlug, runs: readonly ShepherdedRun[]): Promise<PrRow[]> {
  const { prs, at } = await snapshot.openList(repo);
  return prs.sort((a, b) => a.number - b.number).map((pr) => {
    const entry = runFor(runs, repo, pr);
    const ci = ciOf(pr.headSha, snapshot.cachedRuns(repo, pr.headSha), entry && requiredContexts(entry.run));
    return { ...openFields(repo, pr), ...registeredFields(entry), ...(ci && { ci }), source: "snapshot" as const, at: iso(at) };
  });
}

function openFields(repo: RepoSlug, pr: PullRequest): Omit<PrRow, "registered" | "source" | "at"> {
  return { repo, number: pr.number, branch: pr.headRef, headSha: pr.headSha, base: pr.baseRef, state: "open", mergedAt: null, mergeSha: null, title: pr.title ?? null, body: pr.body ?? null, draft: pr.draft };
}

function registeredFields(entry: ShepherdedRun | undefined): Pick<PrRow, "registered" | "runId" | "phase"> {
  return entry ? { registered: true, runId: entry.run.id, phase: entry.phase } : { registered: false };
}

/** A branch registration counts for the PR its branch opened until it records a PR of its own. */
function runFor(runs: readonly ShepherdedRun[], repo: RepoSlug, pr: PullRequest): ShepherdedRun | undefined {
  const mine = runs.filter(({ registration }) => registration.repo === repo);
  return mine.find(({ registration }) => registration.pr === pr.number) ?? mine.find(({ registration }) => registration.pr === null && registration.branch === pr.headRef);
}

function ciOf(head: string, cached: CachedRuns | undefined, required: readonly string[] = []): PrRowCi | undefined {
  if (!cached) return undefined;
  const runs = latestPerName(cached.runs);
  const names = new Set(runs.map((run) => run.name));
  const requiredMissing = required.filter((context) => !names.has(context));
  const state = runs.length === 0 ? "none" : ciVerdict({ rules: { contexts: [...required], strict: false }, runs, statuses: [] }).verdict;
  return { head, state, requiredMissing, at: iso(cached.at) };
}

function latest<T>(run: WorkflowRun, stepId: string, schema: z.ZodType<T>): { step: StepResult; data: T } | undefined {
  const found = Object.values(run.stepResults).filter((step) => stepIdMatches(stepId, step.stepId)).flatMap((step) => {
    const parsed = schema.safeParse(step.data);
    return parsed.success ? [{ step, data: parsed.data }] : [];
  });
  return found.sort((a, b) => a.step.completedAt.localeCompare(b.step.completedAt)).at(-1);
}

const requiredContexts = (run: WorkflowRun): string[] | undefined => latest(run, "land-rules", LandRules)?.data.result.contexts;

function mergedRow({ registration, run, phase, headSha }: ShepherdedRun, since: number): PrRow | undefined {
  const merge = latest(run, "merge", MergeLanded);
  if (registration.pr === null || !merge || Date.parse(merge.step.completedAt) < since) return undefined;
  const base = latest(run, "land-rules", LandRules)?.data.result.base ?? null;
  const branch = registration.branch ?? run.params["branch"] ?? null;
  const fields = { repo: registration.repo, number: registration.pr, branch, headSha, base, state: "merged" as const, mergedAt: merge.step.completedAt };
  return { ...fields, mergeSha: merge.data.result.mergeSha, title: null, body: null, draft: false, registered: true, runId: run.id, phase, source: "merge-step", at: merge.step.completedAt };
}

const FINISHED_PAGE = 200;

/** The shepherd runs that finished inside the window, a page at a time; other workflows' runs are skipped. */
function finishedSince(host: FactoryHost, services: ShepherdServices, since: number): RowWithRun[] {
  const found: RowWithRun[] = [];
  const pendingGates = host.pendingGates();
  for (let after = ""; ; ) {
    const page = host.runs.page(["completed", "failed", "cancelled"], { after, limit: FINISHED_PAGE, completedSince: iso(since) });
    for (const run of page) {
      const registration = services.store.get().byRun(run.id);
      if (registration) found.push({ row: rowOf(host, services, registration, run, pendingGates), run, registration });
    }
    if (page.length < FINISHED_PAGE) return found;
    after = page.at(-1)!.id;
  }
}

/** What `shepherd.prs` reads on a host: live runs, runs finished inside the window, and the seat book's repos. */
export function hostPrsSources(host: FactoryHost, services: ShepherdServices, snapshot: PrsSources["snapshot"]): PrsSources {
  const shepherded = async (since: number): Promise<ShepherdedRun[]> => {
    const live = await rowsWithRuns(host, services, (_registration, status) => !runFinished(status));
    return [...live, ...finishedSince(host, services, since)].map(({ row, run, registration }) => ({ registration, run, phase: row.phase, headSha: row.headSha }));
  };
  return { snapshot, shepherded, seatRepos: () => services.seats().seats.flatMap((seat) => seat.remotes), now: services.now ?? Date.now };
}
