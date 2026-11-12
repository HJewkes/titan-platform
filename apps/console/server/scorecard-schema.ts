import { z } from "zod";
import type { PhaseWeek, Provenance, TaskRow, WeekMetrics } from "@titan-design/session-analytics";

/**
 * The ticket scorecard's answers (TP-5446 S6). Each schema is pinned to session-analytics' own type, so a field the
 * scorecard core renames fails typecheck here instead of reaching the page as undefined. Null always means not measured.
 */

const measured = z.number().nullable();

const weekMetrics = z.object({
  dispatched: z.number(),
  productShare: measured,
  upkeepShare: measured,
  ownerSourcedShare: measured,
  sameDayShare: measured,
  ageMedianH: measured,
  ruleAgreement: measured,
  ruleRankPctMedian: measured,
  merged: z.number(),
  leadDispatchMergeMedianH: measured,
  leadDispatchMergeP90H: measured,
  fixRounds3PlusShare: measured,
  reviewRoundsMedian: measured,
  reverts: z.number(),
  followupsPerMerged: measured,
  usd: z.number(),
  costPerMerged: measured,
  unmergedUsd: z.number(),
  ownerGatedShare: measured,
  ownerGateHours: z.number(),
  inferredShare: measured,
}) satisfies z.ZodType<WeekMetrics>;

/** `dimension` stays a string: a `seat` breakdown arrives with F12 `dispatch_rule`, and the page already has a table for it. */
const weekCell = z.object({ dimension: z.string(), key: z.string(), metrics: weekMetrics, redFlags: z.array(z.string()) });

const phaseCell = z.object({
  isoWeek: z.string(),
  repo: z.string(),
  stage: z.string(),
  runs: z.number(),
  medianMinutes: z.number(),
  p90Minutes: z.number(),
}) satisfies z.ZodType<PhaseWeek>;

/** `frozen` when the job wrote `weeks/<week>.json`; `drift` when a later run computed it differently and wrote `<week>.drift.json`. */
const scorecardWeek = z.object({ isoWeek: z.string(), frozen: z.boolean(), drift: z.boolean(), cells: z.array(weekCell), phases: z.array(phaseCell) });

/** `missing` is a host with no store yet; `unreadable` a store that would not open, with why. */
const storeState = z.discriminatedUnion("state", [z.object({ state: z.literal("ok") }), z.object({ state: z.enum(["missing", "unreadable"]), detail: z.string() })]);

export const weeksResult = z.object({ store: storeState, weeks: z.array(scorecardWeek) });

const provenance = z.custom<Provenance>((value) => value === "recorded" || (typeof value === "string" && value.startsWith("inferred:")));

const taskRowSchema = z.object({
  initiative: z.string(),
  taskId: z.string(),
  firstDispatchTs: z.string(),
  dispatcher: z.string(),
  dispatchRule: z.string().nullable(),
  classAtDispatch: z.enum(["product", "upkeep"]).nullable(),
  sourceAtDispatch: z.string().nullable(),
  servesAtDispatch: z.string().nullable(),
  rankAtDispatch: z.string().nullable(),
  ageAtDispatchH: measured,
  ruleRankPct: measured,
  inRuleTopk: z.boolean().nullable(),
  mergedAt: z.string().nullable(),
  prs: z.number(),
  fixRounds: z.number(),
  reviewRounds: z.number(),
  revertedBy: z.string().nullable(),
  doneReason: z.string().nullable(),
  followupsN: measured,
  followupsEst: measured,
  briefHasDoneWhen: z.boolean().nullable(),
  leadCreatedDoneH: measured,
  leadDispatchMergeH: measured,
  usd: measured,
  usdLink: provenance.nullable(),
  ownerGates: z.number(),
  ownerGateHours: z.number(),
  dupPrs: z.number(),
  provenance: z.record(z.string(), provenance),
}) satisfies z.ZodType<Omit<TaskRow, "inputsHash">>;

/** A capped list: `total` counts every row that matched, `rows` holds the newest dispatches first. */
export const tasksResult = z.object({ store: storeState, total: z.number(), rows: z.array(taskRowSchema) });

export const taskResult = z.object({ store: storeState, row: taskRowSchema.nullable() });

export type ScorecardWeek = z.infer<typeof scorecardWeek>;
export type ScorecardCell = z.infer<typeof weekCell>;
export type ScorecardTaskRow = z.infer<typeof taskRowSchema>;
export type ScorecardStoreState = z.infer<typeof storeState>;
