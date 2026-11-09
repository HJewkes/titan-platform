import type { GateRecord } from "@titan-design/hitl";
import { isIsoTime } from "./iso-time.js";

export interface MergedPr {
  number: number;
  mergedAt: string;
}

export interface RedRun {
  id: number;
  workflow: string;
  createdAt: string;
}

/** A console round the owner answered; `submittedAt` is the feedback's own time, not the file's, and is absent, with `why`, when the round cannot be dated. */
export type RoundAnswer = { id: string; submittedAt: string } | { id: string; submittedAt: undefined; why: string };

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
const inWindow = (at: string | undefined, since: string): boolean => at !== undefined && isIsoTime(at) && isIsoTime(since) && Date.parse(at) >= Date.parse(since);

/** An event whose time cannot be read is not dropped: the wake must see it, so it gets its own "at an unknown time" line. */
function splitByTime<T>(items: readonly T[], timeOf: (item: T) => string | undefined, since: string): { inside: T[]; undatable: T[] } {
  const inside = items.filter((item) => inWindow(timeOf(item), since));
  const undatable = items.filter((item) => !isIsoTime(timeOf(item) ?? ""));
  return { inside, undatable };
}

async function mergesSince(sources: WindowSources, since: string): Promise<string[]> {
  const merged = async (repo: string) => {
    const { inside, undatable } = splitByTime(await sources.github.mergedPrs(repo, since), (pr) => pr.mergedAt, since);
    return [...inside.map((pr) => `${repo}#${pr.number} merged ${pr.mergedAt}`), ...undatable.map((pr) => `${repo}#${pr.number} merged at an unknown time`)];
  };
  return (await Promise.all(sources.repos.map(merged))).flat();
}

async function ownerContactSince(sources: WindowSources, since: string): Promise<string[]> {
  const resolved = sources.gates().filter((gate) => gate.status === "resolved");
  const gates = splitByTime(resolved, (gate) => gate.resolvedAt, since);
  const rounds = await sources.rounds();
  const answers = rounds.filter((round) => inWindow(round.submittedAt, since));
  const undatable = rounds.flatMap((round) => (round.submittedAt === undefined ? [round] : []));
  return [
    ...gates.inside.map((gate) => `gate ${gate.id} resolved ${gate.resolvedAt}`),
    ...gates.undatable.map((gate) => `gate ${gate.id} resolved at an unknown time`),
    ...answers.map((round) => `round ${round.id} answered ${round.submittedAt}`),
    ...undatable.map((round) => `round ${round.id} answered at an unknown time: ${round.why}`),
  ];
}

async function newRedSince(sources: WindowSources, since: string): Promise<string[]> {
  const red = async (repo: string) => {
    const { inside, undatable } = splitByTime(await sources.github.redMainRuns(repo, since), (run) => run.createdAt, since);
    return [
      ...inside.map((run) => `${repo} main run ${run.id} (${run.workflow}) failed ${run.createdAt}`),
      ...undatable.map((run) => `${repo} main run ${run.id} (${run.workflow}) failed at an unknown time`),
    ];
  };
  const runs = (await Promise.all(sources.repos.map(red))).flat();
  const gates = splitByTime(sources.gates().filter((gate) => CI_FAILED_GATE.test(gate.id)), (gate) => gate.createdAt, since);
  return [...runs, ...gates.inside.map((gate) => `gate ${gate.id} opened ${gate.createdAt}`), ...gates.undatable.map((gate) => `gate ${gate.id} opened at an unknown time`)];
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
