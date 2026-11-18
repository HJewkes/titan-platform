import { inputsHash } from "./inputs-hash.js";
import { hoursBetween } from "./stats.js";
import {
  duplicatePrs,
  earliestMerge,
  firstDispatch,
  fixRounds,
  ownerGates,
  registeredPrs,
  reviewRounds,
} from "./task-row-facts.js";
import type { ClassLabel, Labelled, Provenance, ScorecardLabels, TaskClass, TaskRow, TaskRowInput } from "./types.js";

type LabelFacts = Pick<
  TaskRow,
  | "classAtDispatch"
  | "sourceAtDispatch"
  | "servesAtDispatch"
  | "rankAtDispatch"
  | "doneReason"
  | "revertedBy"
  | "briefHasDoneWhen"
  | "followupsN"
  | "followupsEst"
>;

type OutcomeFacts = Pick<
  TaskRow,
  | "mergedAt"
  | "prs"
  | "fixRounds"
  | "reviewRounds"
  | "leadCreatedDoneH"
  | "leadDispatchMergeH"
  | "usd"
  | "usdLink"
  | "ownerGates"
  | "ownerGateHours"
  | "dupPrs"
>;

/** The owner's 2026-11-12 decision: class is binary, and an inferred `mixed` counts as upkeep. */
function taskClassOf(label: ClassLabel): TaskClass {
  return label === "product" ? "product" : "upkeep";
}

/**
 * The scorecard row for one task, or null when no worker spawn outside Shepherd dispatched it.
 * A pure function of its input: the same input always gives the same row and `inputsHash`.
 */
export function taskRow(input: TaskRowInput): TaskRow | null {
  const dispatch = firstDispatch(input.spawns);
  if (dispatch === null) return null;
  const { task } = input;
  return {
    initiative: task.initiative,
    taskId: task.taskId,
    firstDispatchTs: dispatch.ts,
    dispatcher: dispatch.actor,
    dispatchRule: dispatch.dispatchRule,
    ...labelFacts(input.labels),
    ageAtDispatchH: hoursBetween(task.createdAt, dispatch.ts),
    ruleRankPct: input.rule?.rankPct ?? null,
    inRuleTopk: input.rule?.inTopK ?? null,
    ...outcomeFacts(input, dispatch.ts),
    provenance: { ...provenanceOf(input), ...(dispatch.link === undefined ? {} : { firstDispatchTs: dispatch.link }) },
    inputsHash: inputsHash(input),
  };
}

function outcomeFacts(input: TaskRowInput, dispatchTs: string): OutcomeFacts {
  const prs = registeredPrs(input.registrations, input.prs);
  const mergedAt = earliestMerge(prs);
  const gates = ownerGates(input.gates);
  return {
    mergedAt,
    prs: prs.length,
    fixRounds: fixRounds(input.runs),
    reviewRounds: reviewRounds(input.runs),
    leadCreatedDoneH: hoursBetween(input.task.createdAt, input.task.doneAt),
    leadDispatchMergeH: hoursBetween(dispatchTs, mergedAt),
    usd: input.actuals?.usd ?? null,
    usdLink: input.actuals?.link ?? null,
    ownerGates: gates.count,
    ownerGateHours: gates.hours,
    dupPrs: duplicatePrs(prs),
  };
}

function labelFacts(labels: ScorecardLabels): LabelFacts {
  const followUps = labels.followUps?.value;
  return {
    classAtDispatch: labels.class === undefined ? null : taskClassOf(labels.class.value),
    sourceAtDispatch: labels.source?.value ?? null,
    servesAtDispatch: labels.serves?.value ?? null,
    rankAtDispatch: labels.rank?.value ?? null,
    doneReason: labels.doneReason?.value ?? null,
    revertedBy: labels.revertedBy?.value ?? null,
    briefHasDoneWhen: labels.briefHasDoneWhen?.value ?? null,
    followupsN: followUps === undefined ? null : followUps.length,
    followupsEst: followUps === undefined ? null : followUps.reduce((acc, f) => acc + (f.estimate ?? 0), 0),
  };
}

/** Each labelled column's origin; columns read straight from recorded rows carry no entry. */
function provenanceOf(input: TaskRowInput): Record<string, Provenance> {
  const { labels } = input;
  const columns: [string, Labelled<unknown> | undefined][] = [
    ["classAtDispatch", labels.class],
    ["sourceAtDispatch", labels.source],
    ["servesAtDispatch", labels.serves],
    ["rankAtDispatch", labels.rank],
    ["doneReason", labels.doneReason],
    ["revertedBy", labels.revertedBy],
    ["briefHasDoneWhen", labels.briefHasDoneWhen],
    ["followups", labels.followUps],
  ];
  const provenance: Record<string, Provenance> = {};
  for (const [column, label] of columns) if (label !== undefined) provenance[column] = label.origin;
  if (input.actuals !== undefined) provenance.usd = input.actuals.link;
  return provenance;
}

/** True when any column of the row rests on an inferred value. */
export function isInferred(row: Pick<TaskRow, "provenance">): boolean {
  return Object.values(row.provenance).some((origin) => origin !== "recorded");
}
