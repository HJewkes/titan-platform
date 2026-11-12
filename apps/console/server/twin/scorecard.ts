// The ticket scorecard's twin answers: synthetic weeks, dispatchers and tasks, typed by the commands the page calls.
import type { ScorecardTaskRow } from "../scorecard-schema.js";
import { answer, type TwinCall } from "./answers.js";

const OPEN_WEEK = "2031-W10";
const CLOSED_WEEK = "2031-W09";
const INFERRED = "inferred:census-2031-03-01";

type Metrics = Parameters<typeof answer<"scorecard.weeks">>[2]["weeks"][number]["cells"][number]["metrics"];

function metrics(overrides: Partial<Metrics>): Metrics {
  return {
    dispatched: 12, productShare: 0.58, upkeepShare: 0.42, ownerSourcedShare: 0.17, sameDayShare: 0.5, ageMedianH: 30, ruleAgreement: 0.25,
    ruleRankPctMedian: 40, merged: 9, leadDispatchMergeMedianH: 5.5, leadDispatchMergeP90H: 22, fixRounds3PlusShare: 0.1, reviewRoundsMedian: 1,
    reverts: 0, followupsPerMerged: 0.33, usd: 61.2, costPerMerged: 6.8, unmergedUsd: 4.1, ownerGatedShare: 0.08, ownerGateHours: 3.5, inferredShare: 0.75,
    ...overrides,
  };
}

const OPEN_CELLS = [
  { dimension: "all", key: "all", metrics: metrics({}), redFlags: ["upkeep-cap"] },
  { dimension: "dispatcher", key: "orbit-coord", metrics: metrics({ dispatched: 8, merged: 6, upkeepShare: 0.5 }), redFlags: ["upkeep-cap"] },
  { dimension: "dispatcher", key: "kiln-coord", metrics: metrics({ dispatched: 4, merged: 3, upkeepShare: 0.25, costPerMerged: null }), redFlags: [] },
  { dimension: "initiative", key: "orbit-relay", metrics: metrics({ dispatched: 12 }), redFlags: ["upkeep-cap"] },
];

const CLOSED_CELLS = [{ dimension: "all", key: "all", metrics: metrics({ dispatched: 15, merged: 13, upkeepShare: 0.2, costPerMerged: 5.9 }), redFlags: [] }];

const PHASES = [
  { isoWeek: OPEN_WEEK, repo: "all", stage: "ci", runs: 9, medianMinutes: 14, p90Minutes: 31 },
  { isoWeek: OPEN_WEEK, repo: "all", stage: "review", runs: 9, medianMinutes: 22, p90Minutes: 58 },
];

function task(taskId: string, overrides: Partial<ScorecardTaskRow>): ScorecardTaskRow {
  return {
    initiative: "orbit-relay", taskId, firstDispatchTs: "2031-03-04T09:00:00.000Z", dispatcher: "orbit-coord", dispatchRule: null,
    classAtDispatch: "product", sourceAtDispatch: "plan", servesAtDispatch: null, rankAtDispatch: null, ageAtDispatchH: 20, ruleRankPct: 35, inRuleTopk: true,
    mergedAt: "2031-03-04T15:00:00.000Z", prs: 1, fixRounds: 0, reviewRounds: 1, revertedBy: null, doneReason: null, followupsN: 0, followupsEst: 0,
    briefHasDoneWhen: true, leadCreatedDoneH: 26, leadDispatchMergeH: 6, usd: 5.2, usdLink: "recorded", ownerGates: 0, ownerGateHours: 0, dupPrs: 0,
    provenance: { classAtDispatch: "recorded", sourceAtDispatch: "recorded" },
    ...overrides,
  };
}

const BACKOFF = task("OR-12", {});
const RETRY = task("OR-15", {
  classAtDispatch: "upkeep", sourceAtDispatch: "follow-up", mergedAt: null, fixRounds: 3, leadDispatchMergeH: null, usd: null, usdLink: null,
  provenance: { classAtDispatch: INFERRED, sourceAtDispatch: INFERRED },
});

export const SCORECARD_ANSWERS: readonly TwinCall[] = [
  answer("scorecard.weeks", {}, {
    store: { state: "ok" },
    weeks: [
      { isoWeek: OPEN_WEEK, frozen: false, drift: false, cells: OPEN_CELLS, phases: PHASES },
      { isoWeek: CLOSED_WEEK, frozen: true, drift: false, cells: CLOSED_CELLS, phases: [] },
    ],
  }),
  answer("scorecard.tasks", { week: OPEN_WEEK }, { store: { state: "ok" }, total: 2, rows: [RETRY, BACKOFF] }),
  answer("scorecard.tasks", { inferred: true }, { store: { state: "ok" }, total: 1, rows: [RETRY] }),
  answer("scorecard.task", { initiative: "orbit-relay", taskId: "OR-15" }, { store: { state: "ok" }, row: RETRY }),
];
