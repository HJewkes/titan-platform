import os from "node:os";
import { priceRequest } from "@titan-design/session-analytics";
import { claudeSourceFromPath, readSessionObservations, type NormalizedObservationOf } from "@titan-design/session-read";
import type { WorkflowRun } from "@titan-design/workflow";
import { median, p90 } from "./stage-times.js";
import { inRange, isoWeek, mergedAt, payloadOf, stepName } from "./stats.js";

/** Disjoint token counts: `input` excludes cache reads and writes. */
interface CostTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface SessionRequest {
  responseId: string;
  model: string | null;
  /** ISO timestamp the request is priced at. */
  at: string;
  tokens: { input: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; output: number };
}

export type SessionRead = { ok: true; requests: SessionRequest[] } | { ok: false; reason: string };

/** Reads one reviewer transcript, read-only; injected so tests never touch a real transcript root. */
export interface TranscriptPort {
  read(path: string): Promise<SessionRead>;
}

interface UnreadableSession {
  session: string;
  reason: string;
}

interface PrCost {
  repo: string;
  pr: number;
  /** ISO week of the merge. */
  week: string;
  /** Reviews dispatched for the PR across all its runs, whether or not they came to a verdict. */
  rounds: number;
  /** Distinct reviewer sessions those rounds ran in. */
  sessions: number;
  /** Rounds priced in full; an unreadable round adds nothing here and is listed instead. */
  usd: number;
  tokens: CostTokens;
  unreadable: UnreadableSession[];
}

interface Rollup {
  prs: number;
  usd: number;
  tokens: CostTokens;
  /** Unreadable rounds, summed over the PRs. */
  unreadable: number;
  /** Over PRs with no unreadable round; null when there are none. */
  p50Usd: number | null;
  p90Usd: number | null;
}

type CostWeek = { repo: string; week: string } & Rollup;

export interface ReviewCostReport {
  prs: PrCost[];
  weeks: CostWeek[];
  totals: Rollup & { completePrs: number };
}

/**
 * One paid review, from its dispatch to the step that resolved it, in ms; a standing or named reviewer serves several PRs in one session.
 * `to` is null when no step resolved it, and `path` is null until a verdict's locator names the transcript.
 */
interface Round {
  session: string;
  path: string | null;
  from: number;
  to: number | null;
}

interface MergedPr {
  repo: string;
  pr: number;
  mergedAt: number;
  rounds: Round[];
}

const emptyTokens = (): CostTokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const round = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/** The on-time wait, its `:corrected` reply and the late read each resolve a round, with a verdict or a timeout. */
const RESOLVING_STEPS = new Set(["sh-await-verdict", "sh-late-verdict"]);

/** A started reviewer's `sh-review` opens a round, and so does an external intent, which starts nobody; the intent's `at` bounds what can be the verdict. */
function openedRound(name: string, result: Record<string, unknown>, runStart: number): Round | undefined {
  const opened = (name === "sh-review" && result.kind === "dispatched") || (name === "sh-review-intent" && result.kind === "intent" && result.mode === "external");
  if (!opened) return undefined;
  const session = typeof result.sessionId === "string" ? result.sessionId : String(result.reviewer ?? "unknown");
  return { session, path: null, from: typeof result.at === "number" ? result.at : runStart, to: null };
}

/** Only a verdict names its transcript; the dispatch knows the session but not where it is written. */
function locatorOf(result: Record<string, unknown>): Partial<Pick<Round, "session" | "path">> {
  if (result.kind !== "verdict") return {};
  const locator = result.locator as { source?: { path?: unknown; conversation?: { nativeId?: unknown } } } | undefined;
  const nativeId = locator?.source?.conversation?.nativeId;
  const reviewer = (result.reviewer as { sessionId?: unknown } | undefined)?.sessionId;
  const session = typeof nativeId === "string" ? nativeId : typeof reviewer === "string" ? reviewer : undefined;
  return { ...(session !== undefined && { session }), ...(typeof locator?.source?.path === "string" && { path: locator.source.path }) };
}

/** Steps are stored in the order they were recorded, so a resolving step belongs to the latest round opened before it, and the last one ends it. */
function roundsOf(run: WorkflowRun): Round[] {
  const rounds: Round[] = [];
  for (const [key, step] of Object.entries(run.stepResults)) {
    const name = stepName(key);
    const result = payloadOf(step);
    const opened = openedRound(name, result, Date.parse(run.startedAt));
    if (opened) rounds.push(opened);
    const current = rounds.at(-1);
    if (!current || !RESOLVING_STEPS.has(name)) continue;
    current.to = Math.max(current.to ?? 0, Date.parse(step.completedAt));
    Object.assign(current, locatorOf(result));
  }
  return rounds;
}

function prNumberOf(run: WorkflowRun): number | undefined {
  const awaited = Object.entries(run.stepResults).find(([key]) => key.split(":")[0] === "sh-await-pr");
  const pr = Number(run.params.pr ?? (awaited ? payloadOf(awaited[1]).pr : undefined));
  return Number.isInteger(pr) && pr > 0 ? pr : undefined;
}

/** Every run of a PR counts toward it, since a re-registered PR's earlier reviews were paid for too; only a merged PR is reported. */
function mergedPrs(runs: readonly WorkflowRun[]): MergedPr[] {
  const prs = new Map<string, MergedPr & { merged: boolean }>();
  for (const run of runs) {
    const repo = run.params.repo?.toLowerCase();
    const pr = prNumberOf(run);
    if (!repo || pr === undefined) continue;
    const entry = prs.get(`${repo}#${pr}`) ?? { repo, pr, mergedAt: Number.POSITIVE_INFINITY, rounds: [], merged: false };
    prs.set(`${repo}#${pr}`, entry);
    const merged = mergedAt(run);
    if (merged !== undefined) Object.assign(entry, { merged: true, mergedAt: Math.min(entry.mergedAt, merged) });
    entry.rounds.push(...roundsOf(run));
  }
  return [...prs.values()].filter((entry) => entry.merged).map(({ merged: _, ...entry }) => entry);
}

interface RoundCost {
  usd: number;
  tokens: CostTokens;
}

/** A request already counted anywhere in the report (a resumed session repeats its history) is skipped; an unpriced model voids the round. */
function priceRound(requests: readonly SessionRequest[], seen: Set<string>): RoundCost | { reason: string } {
  const cost: RoundCost = { usd: 0, tokens: emptyTokens() };
  const fresh = [...new Map(requests.map((request) => [request.responseId, request])).values()].filter((request) => !seen.has(request.responseId));
  for (const { model, at, tokens } of fresh) {
    const priced = priceRequest({ inputTokens: tokens.input, cacheReadTokens: tokens.cacheRead, cacheCreation5mTokens: tokens.cacheWrite5m, cacheCreation1hTokens: tokens.cacheWrite1h, outputTokens: tokens.output }, model ?? "", at);
    if (!priced.priced) return { reason: `unknown model ${model ?? "(none)"}` };
    cost.usd += priced.costUsd;
    addTokens(cost.tokens, { input: tokens.input, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite5m + tokens.cacheWrite1h, output: tokens.output });
  }
  for (const request of fresh) seen.add(request.responseId);
  return cost;
}

function addTokens(into: CostTokens, from: CostTokens): void {
  into.input += from.input;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.output += from.output;
}

/** A round no verdict located, such as one that timed out, is read from the transcript another round's verdict named for its session. */
function transcriptPaths(runs: readonly WorkflowRun[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const { session, path } of runs.flatMap(roundsOf)) if (path !== null) paths.set(session, path);
  return paths;
}

/** A round is priced over its own window, or it is unreadable with a reason; none is priced as a silent zero. */
async function costOfRound({ session, path, from, to }: Round, paths: ReadonlyMap<string, string>, read: TranscriptPort["read"], seen: Set<string>): Promise<RoundCost | { reason: string }> {
  if (to === null) return { reason: "no step resolved the round" };
  const located = path ?? paths.get(session);
  if (located === undefined) return { reason: "no transcript path" };
  const transcript = await read(located);
  if (!transcript.ok) return transcript;
  const requests = transcript.requests.filter((request) => Date.parse(request.at) >= from && Date.parse(request.at) <= to);
  return requests.length === 0 ? { reason: "no requests in the round's window" } : priceRound(requests, seen);
}

/** `seen` spans the report, so a request in two rounds' windows is priced once. */
async function costOfPr(pr: MergedPr, paths: ReadonlyMap<string, string>, read: TranscriptPort["read"], seen: Set<string>): Promise<PrCost> {
  const sessions = new Set(pr.rounds.map((r) => r.session)).size;
  const cost: PrCost = { repo: pr.repo, pr: pr.pr, week: isoWeek(pr.mergedAt), rounds: pr.rounds.length, sessions, usd: 0, tokens: emptyTokens(), unreadable: [] };
  for (const reviewRound of pr.rounds) {
    const priced = await costOfRound(reviewRound, paths, read, seen);
    if ("reason" in priced) {
      cost.unreadable.push({ session: reviewRound.session, reason: priced.reason });
      continue;
    }
    cost.usd += priced.usd;
    addTokens(cost.tokens, priced.tokens);
  }
  return { ...cost, usd: round(cost.usd) };
}

function rollup(prs: readonly PrCost[]): Rollup {
  const tokens = emptyTokens();
  for (const pr of prs) addTokens(tokens, pr.tokens);
  const complete = prs.filter((pr) => pr.unreadable.length === 0).map((pr) => pr.usd).sort((a, b) => a - b);
  return {
    prs: prs.length,
    usd: round(prs.reduce((sum, pr) => sum + pr.usd, 0)),
    tokens,
    unreadable: prs.reduce((sum, pr) => sum + pr.unreadable.length, 0),
    p50Usd: complete.length === 0 ? null : round(median(complete)),
    p90Usd: complete.length === 0 ? null : round(p90(complete)),
  };
}

function weeksOf(prs: readonly PrCost[]): CostWeek[] {
  const groups = new Map<string, PrCost[]>();
  for (const pr of prs) groups.set(`${pr.repo} ${pr.week}`, [...(groups.get(`${pr.repo} ${pr.week}`) ?? []), pr]);
  return [...groups.values()].map((group) => ({ repo: group[0]!.repo, week: group[0]!.week, ...rollup(group) }));
}

/** Per merged PR: the list-price cost and tokens of every review round dispatched for it, each over its own window, rolled up per repo and ISO week. */
export async function reviewCost(runs: readonly WorkflowRun[], port: TranscriptPort, range: { from?: string; to?: string } = {}): Promise<ReviewCostReport> {
  const merged = mergedPrs(runs).filter((pr) => inRange(pr.mergedAt, range));
  const prs: PrCost[] = [];
  const reads = new Map<string, Promise<SessionRead>>();
  const read = (path: string): Promise<SessionRead> => reads.get(path) ?? reads.set(path, port.read(path)).get(path)!;
  const seen = new Set<string>();
  const paths = transcriptPaths(runs);
  for (const pr of merged) prs.push(await costOfPr(pr, paths, read, seen));
  prs.sort((a, b) => a.repo.localeCompare(b.repo) || a.week.localeCompare(b.week) || a.pr - b.pr);
  return { prs, weeks: weeksOf(prs), totals: { ...rollup(prs), completePrs: prs.filter((pr) => pr.unreadable.length === 0).length } };
}

const usd = (value: number | null): string => (value === null ? "-" : `$${value.toFixed(2)}`);
const tokenText = (t: CostTokens): string => `in ${t.input}  cache read ${t.cacheRead}  cache write ${t.cacheWrite}  out ${t.output}`;
const rollupText = (r: Rollup): string => `PRs ${r.prs}  ${usd(r.usd)}  p50 ${usd(r.p50Usd)}  p90 ${usd(r.p90Usd)}  unreadable ${r.unreadable}  ${tokenText(r.tokens)}`;

function prText(pr: PrCost): string[] {
  const head = `${pr.repo}#${pr.pr}  ${pr.week}  ${usd(pr.usd)}  rounds ${pr.rounds}  sessions ${pr.sessions}  unreadable ${pr.unreadable.length}  ${tokenText(pr.tokens)}`;
  return [head, ...pr.unreadable.map((u) => `  unreadable ${u.session}: ${u.reason}`)];
}

export function formatReviewCost(report: ReviewCostReport): string {
  if (report.prs.length === 0) return "review cost: no merged PRs in range\n";
  const { totals } = report;
  const lines = [
    "review cost per merged PR (an unreadable round adds nothing to the dollars; p50 and p90 cover only PRs read in full):",
    ...report.prs.flatMap(prText),
    "",
    "per repo and ISO week:",
    ...report.weeks.map((w) => `${w.repo}  ${w.week}  ${rollupText(w)}`),
    "",
    `total: ${rollupText(totals)}  read in full ${totals.completePrs}`,
  ];
  return `${lines.join("\n")}\n`;
}

function requestOf(observation: NormalizedObservationOf<"usage">): SessionRequest | undefined {
  const { measurement, timestamp } = observation;
  if (measurement.kind !== "delta" || timestamp === null) return undefined;
  const { cachedInput, cacheWriteInput, input, output } = measurement.tokens;
  const cacheRead = cachedInput ?? 0;
  const cacheWrite = cacheWriteInput ?? 0;
  const split = "cacheWriteSplit" in observation ? observation.cacheWriteSplit : undefined;
  const byTtl = split && split.ttl5m + split.ttl1h > 0 ? { cacheWrite5m: split.ttl5m, cacheWrite1h: split.ttl1h } : { cacheWrite5m: cacheWrite, cacheWrite1h: 0 };
  return { responseId: measurement.responseId, model: measurement.model, at: timestamp, tokens: { input: Math.max(0, (input ?? 0) - cacheRead - cacheWrite), cacheRead, ...byTtl, output: output ?? 0 } };
}

/** Reads Claude Code transcripts through session-read; a later line of a response replaces the earlier one's usage. */
export function claudeTranscripts(namespace = os.hostname()): TranscriptPort {
  return {
    async read(path) {
      const requests = new Map<string, SessionRequest>();
      try {
        for await (const observation of readSessionObservations(claudeSourceFromPath(path, namespace))) {
          const request = observation.kind === "usage" ? requestOf(observation) : undefined;
          if (request) requests.set(request.responseId, { ...request, at: requests.get(request.responseId)?.at ?? request.at });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: "missing transcript" };
        return { ok: false, reason: `parse error: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { ok: true, requests: [...requests.values()] };
    },
  };
}
