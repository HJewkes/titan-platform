import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isUsageLimit } from "@titan-design/review-panel";
import type { Db } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type StepResult, type WorkflowRun, type WorkflowStatus } from "@titan-design/workflow";
import { z } from "zod";
import type { CostSource, ReviewRow, ReviewRunRow, ReviewStatsStore } from "./review-stats-store.js";
import { SHEPHERD_WORKFLOW } from "./services.js";
import { priceRound, type RoundCost, type SessionRead, type TranscriptPort } from "./stats-cost.js";
import { mergedAt, outsideAt, payloadOf, stepName } from "./stats.js";

/** Shepherd-pr runs for a refresh: the finished ones completed at or after `since` (all when undefined), and every unfinished one. */
interface RunSource {
  runs(since: string | undefined): WorkflowRun[];
}

const FINISHED: WorkflowStatus[] = ["completed", "failed", "cancelled"];
const UNFINISHED: WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required"];
const PAGE = 200;

/** Reads the factory ledger a page at a time; the caller opens it read-only. */
export function ledgerRuns(db: Db): RunSource {
  const store = new WorkflowRunStore(db);
  return {
    runs(since) {
      const finished: WorkflowRun[] = [];
      for (let page = store.page(FINISHED, { limit: PAGE, completedSince: since }); page.length > 0; page = store.page(FINISHED, { after: page.at(-1)!.id, limit: PAGE, completedSince: since })) finished.push(...page);
      return [...finished, ...store.listByStatus(UNFINISHED)].filter((run) => run.workflowName === SHEPHERD_WORKFLOW);
    },
  };
}

/** One agent-chat broker retire row's spend for a session. */
interface RetireCost {
  usd: number;
  tokens: NonNullable<ReviewRow["tokens"]>;
  model: string | null;
}

const RetireLine = z.object({
  outcome: z.literal("retired"),
  session_id: z.string(),
  usd_est: z.number(),
  model: z.string().nullable().optional().catch(null),
  models: z.array(z.string()).optional().catch(undefined),
  usage: z.object({ input: z.number(), cache_read: z.number(), cache_write_5m: z.number(), cache_write_1h: z.number(), output: z.number() }).optional().catch(undefined),
});

function retireOf(line: string): [string, RetireCost] | undefined {
  let parsed: z.infer<typeof RetireLine>;
  try {
    parsed = RetireLine.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
  const u = parsed.usage;
  const tokens = u ? { input: u.input, cacheRead: u.cache_read, cacheWrite: u.cache_write_5m + u.cache_write_1h, output: u.output } : { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  return [parsed.session_id, { usd: parsed.usd_est, tokens, model: parsed.models?.join(",") || parsed.model || null }];
}

/**
 * Priced retire rows from every `<logsDir>/<seat>/dispatch.jsonl`, Shepherd's own `logs/shepherd/` included, by session.
 * A resumed session retires again with its whole transcript, so the dearest row of a session is its spend.
 */
export function readRetireCosts(logsDir: string): Map<string, RetireCost> {
  const costs = new Map<string, RetireCost>();
  if (!existsSync(logsDir)) return costs;
  for (const seat of readdirSync(logsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const file = path.join(logsDir, seat.name, "dispatch.jsonl");
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const entry = line.includes('"retired"') ? retireOf(line) : undefined;
      if (entry && entry[1].usd >= (costs.get(entry[0])?.usd ?? -1)) costs.set(...entry);
    }
  }
  return costs;
}

/** A review round as the ledger records it, before it is priced. `final` rounds can no longer change. */
interface Round {
  round: number;
  head: string | null;
  reviewer: string | null;
  sessionId: string | null;
  path: string | null;
  requestedAt: number;
  startedAt: number | null;
  verdictAt: number | null;
  verdict: string | null;
  verdictModel: string | null;
  /** Every step that resolved it was a usage-limit read, so no review happened: never a row. */
  limitOnly: boolean;
  final: boolean;
}

const RESOLVING = new Set(["sh-await-verdict", "sh-late-verdict"]);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
/** Follows `keys` through nested objects of an untyped payload; anything missing or not an object reads as undefined. */
const Node = z.record(z.string(), z.unknown());
const at = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((node, key) => Node.safeParse(node).data?.[key], value);

/** A started reviewer's `sh-review` opens a round, and so does an external intent, which starts nobody. */
function opened(name: string, result: Record<string, unknown>, index: number, runStart: number): Round | undefined {
  const dispatched = name === "sh-review" && result.kind === "dispatched";
  if (!dispatched && !(name === "sh-review-intent" && result.kind === "intent" && result.mode === "external")) return undefined;
  const requestedAt = num(result.at) ?? runStart;
  return {
    round: index, head: text(result.head), reviewer: text(result.reviewer), sessionId: text(result.sessionId), path: null, requestedAt,
    startedAt: dispatched ? num(result.startedAt) : null, verdictAt: null, verdict: null, verdictModel: null, limitOnly: true, final: false,
  };
}

/** The last resolving step wins, as a `:corrected` reply or a late verdict replaces the on-time read. */
function resolve(round: Round, step: StepResult, result: Record<string, unknown>): void {
  round.verdictAt = Date.parse(step.completedAt);
  round.limitOnly &&= isUsageLimit({ kind: String(result.kind), reason: result.reason, notice: result.notice });
  if (result.kind !== "verdict") return void (round.verdict = text(result.kind));
  Object.assign(round, { verdict: text(result.verdict), final: true, path: text(at(result.locator, "source", "path")) ?? round.path });
  round.sessionId ??= text(at(result.locator, "source", "conversation", "nativeId"));
  round.verdictModel = text(at(result.reviewer, "model"));
}

/**
 * Steps are stored in the order they were recorded, so a resolving step belongs to the latest round opened before it.
 * A round is final once it has a verdict, a later round opens, or the run ends; `round` is its ordinal in the run.
 */
function roundsOf(run: WorkflowRun): Round[] {
  const rounds: Round[] = [];
  const runStart = Date.parse(run.startedAt);
  for (const [key, step] of Object.entries(run.stepResults)) {
    const result = payloadOf(step);
    const name = stepName(key);
    const next = opened(name, result, rounds.length, runStart);
    if (next) {
      const previous = rounds.at(-1);
      if (previous) previous.final = true;
      rounds.push(next);
    }
    const current = rounds.at(-1);
    if (current && RESOLVING.has(name)) resolve(current, step, result);
  }
  if (FINISHED.includes(run.status)) for (const round of rounds) round.final = true;
  return rounds.filter((round) => !(round.limitOnly && round.verdictAt !== null));
}

function runRow(run: WorkflowRun): ReviewRunRow {
  const pr = Number(run.params.pr);
  return { runId: run.id, repo: (run.params.repo ?? "").toLowerCase(), pr: Number.isInteger(pr) && pr > 0 ? pr : null, registeredAt: Date.parse(run.startedAt), mergedAt: mergedAt(run) ?? outsideAt(run) ?? null };
}

interface ReviewStatsDeps {
  store: ReviewStatsStore;
  runs: RunSource;
  retire: ReadonlyMap<string, RetireCost>;
  transcripts: TranscriptPort;
}

interface RefreshResult {
  added: number;
  repriced: number;
  transcriptReads: number;
}

interface Pending {
  run: WorkflowRun;
  round: Round;
}

/** Final rounds not yet stored; unfinished rounds wait for a later refresh, so a stored row never changes under a reader. */
function pendingRounds(runs: readonly WorkflowRun[], store: ReviewStatsStore): Pending[] {
  return runs.flatMap((run) => {
    const stored = store.storedRounds(run.id);
    return roundsOf(run).filter((round) => round.final && !stored.has(round.round)).map((round) => ({ run, round }));
  });
}

type Priced = Pick<ReviewRow, "tokens" | "usd" | "costSource" | "model">;
const UNPRICED: Priced = { tokens: null, usd: null, costSource: null, model: null };
const priced = (cost: RoundCost | RetireCost, costSource: CostSource, model: string | null): Priced => ({ tokens: cost.tokens, usd: Math.round(cost.usd * 1e6) / 1e6, costSource, model });

interface Pricer {
  price(round: Round): Promise<Priced>;
  reads: () => number;
}

/** Retire rows price a session that served one round; anything else is priced once from its transcript over the round's own window. */
function pricer({ store, retire, transcripts }: ReviewStatsDeps, pending: readonly Pending[]): Pricer {
  const batch = new Map<string, number>();
  const paths = new Map<string, string>();
  for (const { round } of pending) if (round.sessionId) batch.set(round.sessionId, (batch.get(round.sessionId) ?? 0) + 1);
  for (const { round } of pending) if (round.sessionId && round.path) paths.set(round.sessionId, round.path);
  const reads = new Map<string, Promise<SessionRead>>();
  const seen = new Set<string>();
  const read = (file: string): Promise<SessionRead> => reads.get(file) ?? reads.set(file, transcripts.read(file)).get(file)!;
  const price = async (round: Round): Promise<Priced> => {
    if (!round.sessionId) return UNPRICED;
    const fromRetire = retire.get(round.sessionId);
    if (fromRetire && (batch.get(round.sessionId) ?? 0) + store.roundsOfSession(round.sessionId) === 1) return priced(fromRetire, "retire", fromRetire.model ?? round.verdictModel);
    const file = round.path ?? paths.get(round.sessionId);
    if (file === undefined || round.verdictAt === null) return UNPRICED;
    const transcript = await read(file);
    if (!transcript.ok) return UNPRICED;
    const window = transcript.requests.filter((r) => Date.parse(r.at) >= round.requestedAt && Date.parse(r.at) <= round.verdictAt!);
    const cost = window.length === 0 ? { reason: "empty" } : priceRound(window, seen);
    const models = [...new Set(window.flatMap((r) => r.model ?? []))].join(",") || round.verdictModel;
    return "reason" in cost ? UNPRICED : priced(cost, "transcript", models);
  };
  return { price, reads: () => reads.size };
}

function reviewRow({ run, round }: Pending, cost: Priced): ReviewRow {
  const begun = round.startedAt ?? round.requestedAt;
  return {
    runId: run.id, round: round.round, repo: (run.params.repo ?? "").toLowerCase(), pr: runRow(run).pr, headSha: round.head, reviewer: round.reviewer,
    sessionId: round.sessionId, requestedAt: round.requestedAt, startedAt: round.startedAt, verdictAt: round.verdictAt,
    queueMs: round.startedAt === null ? null : round.startedAt - round.requestedAt, reviewMs: round.verdictAt === null ? null : round.verdictAt - begun,
    verdict: round.verdict, ...cost, model: cost.model ?? round.verdictModel,
  };
}

/** A round stored unpriced takes a retire row written since; this is a lookup, never a transcript read. */
function repriceFromRetire({ store, retire }: ReviewStatsDeps): number {
  let repriced = 0;
  for (const row of store.unpriced()) {
    const cost = retire.get(row.sessionId);
    if (!cost || store.roundsOfSession(row.sessionId) !== 1) continue;
    store.setCost(row, priced(cost, "retire", cost.model));
    repriced += 1;
  }
  return repriced;
}

const latestCompletion = (runs: readonly WorkflowRun[], since: string | undefined): string | undefined =>
  runs.reduce<string | undefined>((max, run) => (FINISHED.includes(run.status) && run.completedAt && (max === undefined || run.completedAt > max) ? run.completedAt : max), since);

/**
 * Brings the store up to date: reads only finished runs completed since the watermark plus the unfinished ones, prices
 * only rounds not yet stored, then writes rows, runs and the new watermark in one transaction.
 */
export async function refreshReviewStats(deps: ReviewStatsDeps): Promise<RefreshResult> {
  const since = deps.store.refreshedThrough();
  const runs = deps.runs.runs(since);
  const pending = pendingRounds(runs, deps.store);
  const { price, reads } = pricer(deps, pending);
  const rows: ReviewRow[] = [];
  for (const item of pending) rows.push(reviewRow(item, await price(item.round)));
  let repriced = 0;
  deps.store.transaction(() => {
    for (const run of runs) deps.store.upsertRun(runRow(run));
    for (const row of rows) deps.store.upsertReview(row);
    repriced = repriceFromRetire(deps);
    const through = latestCompletion(runs, since);
    if (through !== undefined) deps.store.setRefreshedThrough(through);
  });
  return { added: rows.length, repriced, transcriptReads: reads() };
}
