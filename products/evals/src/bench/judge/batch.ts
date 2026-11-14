import { existsSync, readFileSync } from "node:fs";
import { pickControls, placeControls, scoreControls, seededRandom } from "@titan-design/evidence";
import { sha256Hex } from "../../hash.js";
import { appendJsonl } from "../ledger.js";
import { checkAnswer, judgeRequest, type JudgeChoice, type JudgeFn, type JudgeQuestion, type JudgeSpec } from "./core.js";

export const JUDGMENT_SCHEMA = "titan.bench-judgment/v1";
export const TIE = "tie";
export const UNJUDGED = "unjudged";
export const MAX_BATCH_ITEMS = 10;
const MAX_INFLIGHT = 4;
const SECOND_SHARE = 0.2;

/** One judgment: a single question, or a pairwise item's two presentation orders. */
export interface JudgeItem {
  key: string;
  questions: readonly JudgeQuestion[];
}

export interface JudgeControl extends JudgeItem {
  expected: string;
}

export interface BatchPlan extends JudgeChoice {
  id: string;
  track: string;
  items: readonly JudgeItem[];
  controlPool: readonly JudgeControl[];
  controlCount: 1 | 2;
}

export interface BatchDeps {
  judge: JudgeFn;
  ledgerPath: string;
}

export type ItemOutcome = string | null;

export interface BatchResult {
  batchId: string;
  outcome: "passed" | "void";
  items: { key: string; outcome: ItemOutcome; second: ItemOutcome | undefined }[];
}

type Limit = <T>(task: () => Promise<T>) => Promise<T>;

function limiter(max: number): Limit {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    while (active >= max) await new Promise<void>((wake) => waiting.push(wake));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** A pairwise verdict counts only when both orders agree; any dropped order leaves the item without an outcome. */
export function combineOrders(outcomes: readonly ItemOutcome[]): ItemOutcome {
  const [first] = outcomes;
  if (first === undefined || outcomes.some((outcome) => outcome === null)) return null;
  return outcomes.every((outcome) => outcome === first) ? first : TIE;
}

interface CallContext {
  deps: BatchDeps;
  limit: Limit;
  plan: BatchPlan;
  attempt: number;
}

async function judgeItem(ctx: CallContext, spec: JudgeSpec, item: JudgeItem, role: "item" | "control" | "second"): Promise<ItemOutcome> {
  const outcomes = await Promise.all(
    item.questions.map((question, order) =>
      ctx.limit(async () => {
        const call = await ctx.deps.judge(spec, judgeRequest(question));
        const checked = call.ok ? checkAnswer(question, call.answer) : { criteria: [], judgeErrors: question.criteria.length, outcome: null };
        const extra = call.ok ? { sessionId: call.sessionId, effortSeen: call.effortSeen } : { failure: call.reason };
        const where = { batchId: ctx.plan.id, track: ctx.plan.track, attempt: ctx.attempt, role, key: item.key, order };
        appendJsonl(ctx.deps.ledgerPath, { schema: JUDGMENT_SCHEMA, kind: "call", ...where, judge: spec, ...checked, costUsd: call.costUsd, ...extra });
        return checked.outcome;
      }),
    ),
  );
  return combineOrders(outcomes);
}

interface AttemptResult {
  seed: string;
  passed: boolean;
  outcomes: Map<string, ItemOutcome>;
  controls: { key: string; expected: string; answered: ItemOutcome }[];
}

async function runAttempt(ctx: CallContext, seed: string): Promise<AttemptResult> {
  const controls = pickControls(ctx.plan.controlPool, seed, ctx.plan.controlCount);
  const { sequence } = placeControls(ctx.plan.items, controls, seed);
  const judged = await Promise.all(
    sequence.map(async (entry) => ({ entry, outcome: await judgeItem(ctx, ctx.plan.judge, entry.value, entry.kind) })),
  );
  const outcomes = new Map(judged.filter(({ entry }) => entry.kind === "item").map(({ entry, outcome }) => [entry.value.key, outcome]));
  const answered = controls.map((control) => ({ key: control.key, expected: control.expected, answered: judged.find(({ entry }) => entry.value === control)?.outcome ?? null }));
  const score = scoreControls(
    answered.map(({ key, expected }) => ({ id: key, label: expected })),
    answered.flatMap(({ key, answered: label }) => (label === null ? [] : [{ id: key, label }])),
  );
  return { seed, passed: score.correct === score.total, outcomes, controls: answered };
}

/** A seeded share of a batch's items, so which items get a second judge is fixed by the batch id. */
export function secondJudged(batchId: string, keys: readonly string[], share = SECOND_SHARE): Set<string> {
  return new Set(keys.filter((key) => seededRandom(`second:${batchId}:${key}`)() < share));
}

async function secondOutcomes(ctx: CallContext): Promise<Map<string, ItemOutcome>> {
  const chosen = secondJudged(ctx.plan.id, ctx.plan.items.map((item) => item.key));
  const items = ctx.plan.items.filter((item) => chosen.has(item.key));
  return new Map(await Promise.all(items.map(async (item) => [item.key, await judgeItem(ctx, ctx.plan.second, item, "second")] as const)));
}

function record(ctx: CallContext, attempts: AttemptResult[], passed: AttemptResult | undefined, second: Map<string, ItemOutcome>): BatchResult {
  const items = ctx.plan.items.map((item) => ({ key: item.key, outcome: passed === undefined ? UNJUDGED : (passed.outcomes.get(item.key) ?? null), second: second.get(item.key) }));
  const base = { schema: JUDGMENT_SCHEMA, batchId: ctx.plan.id, track: ctx.plan.track, judge: ctx.plan.judge };
  for (const item of items) appendJsonl(ctx.deps.ledgerPath, { ...base, kind: "item", ...item, ...(item.second === undefined ? {} : { secondJudge: ctx.plan.second }) });
  const outcome = passed === undefined ? "void" : "passed";
  appendJsonl(ctx.deps.ledgerPath, { ...base, kind: "batch", outcome, attempts: attempts.map(({ seed, passed: ok, controls }) => ({ seed, passed: ok, controls })) });
  return { batchId: ctx.plan.id, outcome, items };
}

/** Controls must all score correct; a miss re-runs the batch once with a new seed, and a second miss voids it. */
export async function runBatch(plan: BatchPlan, deps: BatchDeps): Promise<BatchResult> {
  const limit = limiter(MAX_INFLIGHT);
  const attempts: AttemptResult[] = [];
  for (const seed of [plan.id, `${plan.id}:rerun`]) {
    const attempt = await runAttempt({ deps, limit, plan, attempt: attempts.length + 1 }, seed);
    attempts.push(attempt);
    if (attempt.passed) return record({ deps, limit, plan, attempt: attempts.length }, attempts, attempt, await secondOutcomes({ deps, limit, plan, attempt: attempts.length }));
  }
  return record({ deps, limit, plan, attempt: attempts.length }, attempts, undefined, new Map());
}

export interface PlannedItem {
  item: JudgeItem;
  judges: JudgeChoice;
}

/** Groups items by judge pair and cuts them into batches of at most ten, each id fixed by its contents. */
export function planBatches(track: string, planned: readonly PlannedItem[], controlPool: readonly JudgeControl[], controlCount: 1 | 2): BatchPlan[] {
  const groups = new Map<string, { judges: JudgeChoice; items: JudgeItem[] }>();
  for (const { item, judges } of planned) {
    const name = `${judges.judge.model}/${judges.judge.effort}/${judges.second.model}/${judges.second.effort}`;
    const group = groups.get(name) ?? { judges, items: [] };
    group.items.push(item);
    groups.set(name, group);
  }
  return [...groups.values()].flatMap(({ judges, items: all }) => {
    const plans: BatchPlan[] = [];
    for (let start = 0; start < all.length; start += MAX_BATCH_ITEMS) {
      const items = all.slice(start, start + MAX_BATCH_ITEMS);
      const id = `${track}-${sha256Hex(items.map((item) => item.key).join("\n")).slice(0, 12)}`;
      plans.push({ id, track, ...judges, items, controlPool, controlCount });
    }
    return plans;
  });
}

export interface JudgmentItemRow {
  kind: "item";
  key: string;
  outcome: ItemOutcome;
  second?: ItemOutcome;
}

export function readItemRows(ledgerPath: string): JudgmentItemRow[] {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const row = JSON.parse(line) as { schema?: unknown; kind?: unknown };
        return row.schema === JUDGMENT_SCHEMA && row.kind === "item" ? [row as JudgmentItemRow] : [];
      } catch {
        return [];
      }
    });
}

export interface Agreement {
  n: number;
  raw: number | null;
  kappa: number | null;
}

/** Cohen's kappa and raw agreement over paired labels; the label set (A/B/tie or binary) is whatever the pairs use. */
export function agreement(pairs: readonly (readonly [string, string])[]): Agreement {
  const n = pairs.length;
  if (n === 0) return { n, raw: null, kappa: null };
  const raw = pairs.filter(([a, b]) => a === b).length / n;
  const labels = new Set(pairs.flat());
  let chance = 0;
  for (const label of labels) chance += (pairs.filter(([a]) => a === label).length / n) * (pairs.filter(([, b]) => b === label).length / n);
  return { n, raw, kappa: chance === 1 ? null : (raw - chance) / (1 - chance) };
}

/** First-versus-second judge agreement over items both judges decided. */
export function secondJudgeAgreement(rows: readonly JudgmentItemRow[]): Agreement {
  const pairs = rows.flatMap((row) => (typeof row.outcome === "string" && row.outcome !== UNJUDGED && typeof row.second === "string" ? [[row.outcome, row.second] as const] : []));
  return agreement(pairs);
}
