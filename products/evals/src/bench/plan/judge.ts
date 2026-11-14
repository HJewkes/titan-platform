import { z } from "zod";
import { TIE, type JudgeControl, type PlannedItem } from "../judge/batch.js";
import { pickJudges, type JudgeQuestion } from "../judge/core.js";
import type { PlanCase } from "./cases.js";
import { parsePlanSlices, type PlanSlice } from "./score.js";

export const ANCHOR_ARM = "O-med";
const A = "A";
const B = "B";

const INSTRUCTIONS = [
  "Two plans were written for the same software task, each by a planner who saw only the task and the repository at the commit it was briefed against.",
  "You also see the landed reference: what the team actually merged for this task. Judge which plan a team would have been better served by, measured against what landed.",
  "Judge only from the texts below. Plan A and plan B are named by position only; their order says nothing about their quality.",
].join(" ");

/** Design section 5's P criteria; `overall` decides the item. */
const CRITERIA = [
  { id: "coverage", ask: "Which plan better covers what landed (the packages and files in the landed reference)?" },
  { id: "landable", ask: "Which plan's slices are more independently landable, each one a PR that can merge on its own?" },
  { id: "tests", ask: "Which plan more consistently names the tests each slice adds?" },
  { id: "consistent", ask: "Which plan has fewer steps that contradict how the code is actually built, per the landed reference?" },
  { id: "overall", ask: "Overall, which plan is closer to what landed and would have needed less rework?" },
] as const;

interface PairTexts {
  task: string;
  planA: string;
  planB: string;
  reference: string;
}

const SWAP: Readonly<Record<string, string>> = { [A]: B, [B]: A, [TIE]: TIE };

/** Both presentation orders; the swapped one relabels its answers back to the canonical A and B. */
function pairQuestions(texts: PairTexts): JudgeQuestion[] {
  const base = { instructions: INSTRUCTIONS, criteria: CRITERIA, labels: [A, B, TIE] as const, decisive: "overall" };
  const shown = (first: string, second: string) => ({ task: texts.task, "plan-A": first, "plan-B": second, "landed-reference": texts.reference });
  return [
    { ...base, texts: shown(texts.planA, texts.planB) },
    { ...base, texts: shown(texts.planB, texts.planA), relabel: SWAP },
  ];
}

const taskText = (planCase: Pick<PlanCase, "title" | "doneWhen">): string => `Task: ${planCase.title}\nDone when: ${planCase.doneWhen}`;

/** Reads what a P run stored: the saved plan of a job, and the landed reference of a case. */
export interface PlanJudgeSource {
  plan: (planFile: string) => string;
  reference: (caseId: string) => string;
}

const ScoreRow = z.looseObject({ arm: z.string(), caseId: z.string(), attempt: z.number().int(), outcome: z.string(), result: z.looseObject({ planFile: z.string() }) });
const JobRef = z.looseObject({ arm: z.looseObject({ id: z.string(), model: z.string() }), caseId: z.string(), attempt: z.number().int() });

interface StoredPlan {
  arm: string;
  model: string;
  text: string;
}

function parsed<T>(schema: z.ZodType<T>, rows: readonly unknown[]): T[] {
  return rows.flatMap((row) => {
    const result = schema.safeParse(row);
    return result.success ? [result.data] : [];
  });
}

/** Each (case, arm)'s latest finished plan with text; a timed-out or empty plan is not judged. */
export function storedPlans(scoreRows: readonly unknown[], jobRows: readonly unknown[], source: PlanJudgeSource): Map<string, Map<string, StoredPlan>> {
  const jobs = parsed(JobRef, jobRows);
  const byCase = new Map<string, Map<string, StoredPlan>>();
  for (const row of parsed(ScoreRow, scoreRows).sort((a, b) => a.attempt - b.attempt)) {
    const job = jobs.find((entry) => entry.arm.id === row.arm && entry.caseId === row.caseId && entry.attempt === row.attempt);
    const text = row.outcome === "ok" && job !== undefined ? source.plan(row.result.planFile) : "";
    const plans = byCase.get(row.caseId) ?? new Map<string, StoredPlan>();
    if (text.trim() === "" || job === undefined) plans.delete(row.arm);
    else plans.set(row.arm, { arm: row.arm, model: job.arm.model, text });
    byCase.set(row.caseId, plans);
  }
  return byCase;
}

/** Keyed case and arm only, never session or attempt, so a resumed judge run skips what it already judged. */
export const pairKey = (caseId: string, arm: string): string => `p:${caseId}:${arm}~${ANCHOR_ARM}`;

/** One pairwise item per non-anchor arm against the anchor on the same case; canonical A is the arm, B the anchor. */
export function planPairItems(plans: ReadonlyMap<string, ReadonlyMap<string, StoredPlan>>, cases: readonly PlanCase[], source: PlanJudgeSource): PlannedItem[] {
  return cases.flatMap((planCase) => {
    const forCase = plans.get(planCase.id);
    const anchor = forCase?.get(ANCHOR_ARM);
    if (forCase === undefined || anchor === undefined) return [];
    const others = [...forCase.values()].filter((plan) => plan.arm !== ANCHOR_ARM).sort((a, b) => a.arm.localeCompare(b.arm));
    return others.map((plan) => {
      const texts = { task: taskText(planCase), planA: plan.text, planB: anchor.text, reference: source.reference(planCase.id) };
      return { item: { key: pairKey(planCase.id, plan.arm), questions: pairQuestions(texts) }, judges: pickJudges([plan.model, anchor.model]) };
    });
  });
}

const renderTests = (tests: unknown): string => (Array.isArray(tests) ? tests.map((test) => (typeof test === "string" ? test : JSON.stringify(test))).join("; ") : JSON.stringify(tests ?? "none"));

/** A plan rebuilt from its slice block alone, so a control's two sides differ only in which slices they hold. */
export function renderSlices(slices: readonly PlanSlice[]): string {
  const lines = slices.map((slice, index) => {
    const estimate = JSON.stringify(slice.estimate ?? null);
    return `${index + 1}. ${slice.title}\n   owns: ${slice.owns.join(", ")}\n   estimate: ${estimate}\n   tests: ${renderTests(slice.tests)}`;
  });
  return `PR-sized slices, in dispatch order:\n${lines.join("\n")}`;
}

const control = (key: string, expected: string, texts: PairTexts): JudgeControl => ({ key, expected, questions: pairQuestions(texts) });

/**
 * Per case with an anchor plan: (a) the plan against itself with half its slices removed, the full one expected to
 * win; (b) the plan against the anchor's plan for a different case, expected to win; (c) the plan against itself, a tie.
 */
export function planControls(plans: ReadonlyMap<string, ReadonlyMap<string, StoredPlan>>, cases: readonly PlanCase[], source: PlanJudgeSource): JudgeControl[] {
  const anchored = cases.flatMap((planCase) => {
    const anchor = plans.get(planCase.id)?.get(ANCHOR_ARM);
    return anchor === undefined ? [] : [{ planCase, text: anchor.text }];
  });
  return anchored.flatMap(({ planCase, text }, index) => {
    const base = { task: taskText(planCase), reference: source.reference(planCase.id) };
    const other = anchored[(index + 1) % anchored.length];
    const slices = parsePlanSlices(text) ?? [];
    const half = slices.slice(0, Math.ceil(slices.length / 2));
    return [
      ...(slices.length >= 2 ? [control(`ctl-a:${planCase.id}`, A, { ...base, planA: renderSlices(slices), planB: renderSlices(half) })] : []),
      ...(other !== undefined && other.planCase.id !== planCase.id ? [control(`ctl-b:${planCase.id}`, A, { ...base, planA: text, planB: other.text })] : []),
      control(`ctl-c:${planCase.id}`, TIE, { ...base, planA: text, planB: text }),
    ];
  });
}
