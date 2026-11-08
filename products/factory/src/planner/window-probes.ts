import type { GateRecord } from "@titan-design/hitl";

export interface MergedPr {
  number: number;
  mergedAt: string;
}

export interface RedRun {
  id: number;
  workflow: string;
  createdAt: string;
}

/** A console round the owner answered; `submittedAt` is the feedback's own time, not the file's. */
export interface RoundAnswer {
  id: string;
  submittedAt: string;
}

export interface WindowGitHub {
  mergedPrs: (repo: string, since: string) => Promise<readonly MergedPr[]>;
  redMainRuns: (repo: string, since: string) => Promise<readonly RedRun[]>;
}

/** Each read throws when its source cannot be read, so the probe exits non-zero and the wake runs the review. */
export interface WindowSources {
  github: WindowGitHub;
  repos: readonly string[];
  gates: () => readonly GateRecord[];
  rounds: () => Promise<readonly RoundAnswer[]>;
}

export const WINDOW_PROBES = ["merges", "owner-contact", "new-red"] as const;
export type WindowProbe = (typeof WINDOW_PROBES)[number];

const CI_FAILED_GATE = /\/ci-failed(:\d+)?$/;

/** GitHub's search qualifiers round to the second, so the window edge is re-checked here. */
const inWindow = (at: string | undefined, since: string): boolean => at !== undefined && Date.parse(at) >= Date.parse(since);

async function perRepo<T>(repos: readonly string[], read: (repo: string) => Promise<readonly T[]>, line: (repo: string, item: T) => string): Promise<string[]> {
  const lines = await Promise.all(repos.map(async (repo) => (await read(repo)).map((item) => line(repo, item))));
  return lines.flat();
}

async function mergesSince(sources: WindowSources, since: string): Promise<string[]> {
  const merged = (repo: string) => sources.github.mergedPrs(repo, since).then((prs) => prs.filter((pr) => inWindow(pr.mergedAt, since)));
  return perRepo(sources.repos, merged, (repo, pr) => `${repo}#${pr.number} merged ${pr.mergedAt}`);
}

async function ownerContactSince(sources: WindowSources, since: string): Promise<string[]> {
  const resolves = sources.gates().filter((gate) => gate.status === "resolved" && inWindow(gate.resolvedAt, since));
  const answers = (await sources.rounds()).filter((round) => inWindow(round.submittedAt, since));
  return [...resolves.map((gate) => `gate ${gate.id} resolved ${gate.resolvedAt}`), ...answers.map((round) => `round ${round.id} answered ${round.submittedAt}`)];
}

async function newRedSince(sources: WindowSources, since: string): Promise<string[]> {
  const red = (repo: string) => sources.github.redMainRuns(repo, since).then((runs) => runs.filter((run) => inWindow(run.createdAt, since)));
  const runs = await perRepo(sources.repos, red, (repo, run) => `${repo} main run ${run.id} (${run.workflow}) failed ${run.createdAt}`);
  const gates = sources.gates().filter((gate) => CI_FAILED_GATE.test(gate.id) && inWindow(gate.createdAt, since));
  return [...runs, ...gates.map((gate) => `gate ${gate.id} opened ${gate.createdAt}`)];
}

const PROBE_READS: Record<WindowProbe, (sources: WindowSources, since: string) => Promise<string[]>> = {
  merges: mergesSince,
  "owner-contact": ownerContactSince,
  "new-red": newRedSince,
};

/** One line per event in the window since `since`; the planner's priorWindow counts the lines. */
export function probeWindow(probe: WindowProbe, sources: WindowSources, since: string): Promise<string[]> {
  return PROBE_READS[probe](sources, since);
}
