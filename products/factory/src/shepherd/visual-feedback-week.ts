// TP-5409 (gate model S6): the visual-week feedback batch. Off unless `shepherd.visualGate` is `async` (S5's switch), so no
// sheet is built while visual still gates the merge. It files through `titan-console decisions file`, the questions-only
// import path; the round's bytes are a function of the week's runs, so a re-run of a closed week files nothing new.
import type { WorkflowRun } from "@titan-design/workflow";
import { EXIT } from "@titan-design/registry";
import { readPath } from "../narrow.js";
import { isoWeekRange, mergedVisualPrs } from "./visual-feedback-merged.js";
import { feedbackRound, type FeedbackRound } from "./visual-feedback-round.js";
import { coded } from "./register-args.js";
import { isoWeek } from "./visual-week.js";

const WEEK_MS = 7 * 86_400_000;

export type Filed = { id: string; created: boolean } | { failed: string };

export interface FeedbackWeekDeps {
  /** The parsed factory config's `shepherd` section; only its `visualGate` is read. */
  shepherd: unknown;
  runs: () => readonly WorkflowRun[];
  now: Date;
  /** Files the round with the console; absent, the batch only prints it. */
  file?: (round: FeedbackRound) => Promise<Filed>;
}

export type FeedbackWeekResult =
  | { mode: "off"; reason: string }
  | { mode: "async"; repo: string; week: string; round: FeedbackRound | null; filed?: Filed };

/** S5 spells the switch `owner | async`, absent meaning owner; anything else reads as owner too. */
export const feedbackModeOn = (shepherd: unknown): boolean => readPath(shepherd, "visualGate") === "async";

/** The last ISO week that has ended by `now`. */
export const lastClosedWeek = (now: Date): string => isoWeek(new Date(now.getTime() - WEEK_MS));

/** A week still running would change under a re-run and conflict with its own filed round, so only an ended one is built. */
export function weekProblem(week: string, now: Date): string | undefined {
  const range = isoWeekRange(week);
  if (range === undefined) return `week ${week} is not an ISO week like 2026-W45`;
  return range.end > now.getTime() ? `week ${week} has not ended; a feedback sheet covers an ended week` : undefined;
}

export async function visualFeedbackWeek(input: { repo: string; week?: string }, deps: FeedbackWeekDeps): Promise<FeedbackWeekResult> {
  if (!feedbackModeOn(deps.shepherd)) return { mode: "off", reason: "shepherd.visualGate is not async: visual still gates the merge, so no post-merge sheet is built" };
  const week = input.week ?? lastClosedWeek(deps.now);
  const problem = weekProblem(week, deps.now);
  if (problem !== undefined) throw coded(problem, EXIT.USAGE);
  const round = feedbackRound(input.repo, week, mergedVisualPrs(deps.runs(), input.repo, week)) ?? null;
  const filed = round && deps.file ? await deps.file(round) : undefined;
  return { mode: "async", repo: input.repo, week, round, ...(filed && { filed }) };
}
