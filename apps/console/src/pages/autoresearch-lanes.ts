import type { ArImplementer, ArLadder, ArRunView } from "../../server/autoresearch-view.js";
import type { Route } from "../router.js";

/**
 * Design §1.3: the board's columns, left to right. The bounds pre-check is no column: it ran when the idea was queued, so
 * every picked card carries it as a passed check.
 */
export const STAGES = [
  { key: "picked", label: "Picked", short: "Pick" },
  { key: "implementing", label: "Implementing", short: "Impl" },
  { key: "l0", label: "L0 unit/test-proof", short: "L0" },
  { key: "l1", label: "L1 micro", short: "L1" },
  { key: "l2", label: "L2 seed eval", short: "L2" },
  { key: "l3", label: "L3 confirm", short: "L3" },
  { key: "judging", label: "Judging / keep", short: "Keep" },
  { key: "done", label: "Done", short: "Done" },
] as const;

type StageKey = (typeof STAGES)[number]["key"];

const STEP_STAGE: Readonly<Record<string, StageKey>> = {
  alloc: "picked",
  implement: "implementing",
  l0: "l0",
  l1: "l1",
  ratchet: "judging",
  release: "done",
  stop: "done",
};

const SEED_EVAL = "r1";
const STEP_ID = /^ar-([a-z0-9-]+):[^:]+(?::(.+))?$/;

/** `ar-eval:<round>/<idea>:<key>` is L2 for the seed run and L3 after; a step id without its key is placed by its order. */
export function stageOfStep(stepId: string, evalsBefore: number): StageKey | undefined {
  const [, name = "", key] = STEP_ID.exec(stepId) ?? [];
  if (name === "eval") return (key ?? (evalsBefore === 0 ? SEED_EVAL : "")) === SEED_EVAL ? "l2" : "l3";
  return STEP_STAGE[name];
}

const stageIndex = (stage: StageKey): number => STAGES.findIndex((entry) => entry.key === stage);

const isEvalStep = (stepId: string): boolean => stepId.startsWith("ar-eval:");

/** The column a ladder's card sits in: its live step's stage, else the stage after the last one it finished. */
export function currentStage(ladder: ArLadder): StageKey {
  if (ladder.outcome !== null) return "done";
  const evals = ladder.completed.filter((step) => isEvalStep(step.stepId)).length;
  const live = ladder.active === null ? undefined : stageOfStep(ladder.active.stepId, evals);
  if (live !== undefined) return live;
  const last = ladder.completed.at(-1);
  const finished = last === undefined ? undefined : stageOfStep(last.stepId, evals - 1);
  return finished === undefined ? "picked" : STAGES[Math.min(stageIndex(finished) + 1, STAGES.length - 1)]!.key;
}

/** The current round's ladders, and any earlier ladder still on its way. */
export function boardLadders(run: ArRunView): ArLadder[] {
  const newest = run.rounds.at(-1);
  const earlierLive = run.rounds.slice(0, -1).flatMap((round) => round.ladders.filter((ladder) => ladder.outcome === null));
  return [...earlierLive, ...(newest?.ladders ?? [])];
}

export type StageState = "completed" | "active" | "upcoming" | "error";

export interface StageSpan {
  key: StageKey;
  short: string;
  state: StageState;
  /** Null when the run has not recorded enough to know it; see `stageSpans`. */
  durationMs: number | null;
  usd: number | null;
}

/**
 * Per-stage state, time and spend for the stepper. The run records no start for a finished step (design gap G1), so a
 * finished stage's time runs from the previous step's end to its own; a live stage's runs from `firstStartedAt`, which a
 * restart keeps.
 */
export function stageSpans(ladder: ArLadder, now: number): StageSpan[] {
  const durations = finishedDurations(ladder);
  const current = currentStage(ladder);
  const failed = failedStage(ladder);
  return STAGES.filter((stage) => stage.key !== "done").map(({ key, short }) => {
    const state = stageState(key, current, failed, ladder);
    const running = state === "active" && ladder.active !== null ? now - Date.parse(ladder.active.firstStartedAt) : null;
    const finished = durations.get(key) ?? null;
    const durationMs = running === null ? finished : running + (finished ?? 0);
    return { key, short, state, durationMs, usd: stageUsd(ladder, key) };
  });
}

function finishedDurations(ladder: ArLadder): Map<StageKey, number> {
  const durations = new Map<StageKey, number>();
  let evals = 0;
  let previousEnd: number | undefined;
  for (const step of ladder.completed) {
    const stage = stageOfStep(step.stepId, evals);
    if (isEvalStep(step.stepId)) evals += 1;
    const end = Date.parse(step.completedAt);
    if (stage !== undefined && previousEnd !== undefined) durations.set(stage, (durations.get(stage) ?? 0) + end - previousEnd);
    previousEnd = end;
  }
  return durations;
}

/** A ladder that ended without a keep stopped at the last stage it worked in before release. */
function failedStage(ladder: ArLadder): StageKey | undefined {
  if (ladder.outcome === null || ladder.outcome.verdict === "kept") return undefined;
  if (ladder.outcome.reason === "superseded") return "judging";
  let evals = 0;
  let last: StageKey | undefined;
  for (const step of ladder.completed) {
    const stage = stageOfStep(step.stepId, evals);
    if (isEvalStep(step.stepId)) evals += 1;
    if (stage !== undefined && stage !== "done") last = stage;
  }
  return last;
}

function stageState(key: StageKey, current: StageKey, failed: StageKey | undefined, ladder: ArLadder): StageState {
  if (failed !== undefined) return key === failed ? "error" : stageIndex(key) < stageIndex(failed) ? "completed" : "upcoming";
  if (ladder.outcome !== null) return "completed";
  if (key === current) return ladder.active === null ? "upcoming" : "active";
  return stageIndex(key) < stageIndex(current) ? "completed" : "upcoming";
}

/** L0 runs no model, and the micro rung's spend is not on the read model yet, so neither shows a dollar figure. */
function stageUsd(ladder: ArLadder, key: StageKey): number | null {
  const total = (repeats: (repeat: string) => boolean) => {
    const runs = ladder.evals.filter((entry) => repeats(entry.repeat));
    return runs.length === 0 ? null : runs.reduce((sum, entry) => sum + entry.usd, 0);
  };
  if (key === "implementing") return ladder.implementUsd;
  if (key === "l2") return total((repeat) => repeat === SEED_EVAL);
  if (key === "l3") return total((repeat) => repeat !== SEED_EVAL);
  return null;
}

/**
 * Design §2.4: the implementer's session log, or, until the implement result records a session id (G2), the agent's own
 * page, which lists the sessions that agent ran.
 */
export function implementerRoute(implementer: ArImplementer | null): Route | undefined {
  if (implementer === null) return undefined;
  return implementer.sessionId === undefined ? { view: "agents", id: implementer.agent } : { view: "sessions", id: implementer.sessionId };
}

export const ideaRoute = (runId: string, ideaId: string): Route => ({ view: "autoresearch", id: runId, query: `idea=${encodeURIComponent(ideaId)}` });

export const ideaFromQuery = (query: string | undefined): string | undefined => new URLSearchParams(query ?? "").get("idea") ?? undefined;
