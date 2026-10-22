/**
 * Concurrent winners (plan 5.2): the picked winner fast-forwards the ratchet, and each later one is merged onto the new
 * head, checked at L0 and run up the keep rung against the new B. Only a winner that is still kept moves the ratchet.
 */
import { createHash } from "node:crypto";
import { canonicalArgs } from "@titan-design/rpc-client";
import { caseRungs, runPinOf, type Built, type RoundContext } from "./ladder.js";
import { arStepId } from "./manifest.js";
import { HeadSchema, IntegrateResultSchema, ReevalSchema, StaticCheckSchema, type RatchetRequest, type Reeval, type RoundSummary } from "./ports.js";
import type { ArResult, Idea, Outcome } from "./schemas.js";
import { recorded, step } from "./steps.js";

type Best = RoundContext["best"];
type Move = RoundSummary["moves"][number];

/** What a round's winners settled on: the new B, every ratchet move in order, and the winners going back in the queue. */
export interface Moved {
  best: Best;
  kept: string[];
  superseded: string[];
  moves: Move[];
  reevals: Reeval[];
  requeue: Idea[];
}

/** One σ per round, so ordering by Δ is ordering by σ-normalized Δ. */
const byStrength = (a: Outcome, b: Outcome) => (b.delta ?? 0) - (a.delta ?? 0) || a.ideaId.localeCompare(b.ideaId);
const smaller = (a: Outcome, b: Outcome) =>
  (a.diff?.srcLines ?? Infinity) - (b.diff?.srcLines ?? Infinity) || (a.diff?.srcFiles ?? Infinity) - (b.diff?.srcFiles ?? Infinity) || a.ideaId.localeCompare(b.ideaId);

/**
 * Winners within σ of the strongest are a tie, and the smallest source diff of those goes first; the rest
 * stay in Δ order. A pick over a fixed set, not a tolerance comparator, which would not be transitive.
 */
export function pickWinner(winners: readonly Outcome[], sigma: number): Outcome[] {
  if (winners.length === 0) return [];
  const top = Math.max(...winners.map((outcome) => outcome.delta ?? 0));
  const [first] = winners.filter((outcome) => (outcome.delta ?? 0) >= top - sigma).sort(smaller);
  return [first!, ...[...winners].sort(byStrength).filter((outcome) => outcome !== first)];
}

const runDigest = (result: ArResult) => createHash("sha256").update(canonicalArgs(result)).digest("hex");

interface Evidence {
  ideaId: string;
  keepRung: string;
  delta: number;
  runs: readonly ArResult[];
}

/** The G12 move record: which idea moved the ratchet, how, on what evidence, against which pin. */
function ratchetRequest(rc: RoundContext, evidence: Evidence, move: Pick<RatchetRequest, "from" | "to" | "kind">): RatchetRequest {
  const { ratchetRef, integrationTree: tree, target } = rc.pinned;
  const { ideaId, keepRung, delta, runs } = evidence;
  const record = { round: rc.round, ideaId, keepRung, delta, sigma: rc.band.sigma, runDigests: runs.map(runDigest), ...runPinOf(rc) };
  return { tree, ratchetRef, ratchetPrefix: target.ratchetPrefix, ...move, ...record };
}

/** The round's first move is `ar-ratchet:<r>`, as before concurrent winners; the nth is `ar-ratchet:<r>.<n>`. */
async function moveRatchet(rc: RoundContext, moves: Move[], request: RatchetRequest): Promise<string> {
  const n = moves.length + 1;
  const { head } = await step(rc.ctx, `${arStepId("ratchet")}:${rc.round}${n === 1 ? "" : `.${n}`}`, request, HeadSchema);
  moves.push({ from: request.from, to: head, kind: request.kind, ideaId: request.ideaId });
  return head;
}

type Started = Pick<Reeval, "ideaId" | "from" | "vs">;

/** L0 on the merge, then the keep rung against the new B under its own scope, so the solo ladder's evals stay its own. */
async function measureMerge(rc: RoundContext, idea: Idea, winner: Outcome, best: Best, merge: string, started: Started): Promise<Reeval> {
  const scope = `${rc.round}/re/${idea.id}`;
  const tree = rc.pinned.integrationTree;
  const checked = await step(rc.ctx, `${arStepId("l0")}:${scope}`, { ...runPinOf(rc), idea, tree, base: best.head, head: merge }, StaticCheckSchema);
  const l0 = { ok: checked.ok, code: checked.code, checks: checked.checks };
  if (!l0.ok) return { ...started, merge, l0, runs: [], decision: "rejected", reason: `rejected:post:${l0.code ?? "unknown"}` };
  const built: Built = { idea, tree, base: best.head, head: merge, branch: winner.branch ?? "", implementUsd: 0, record: { l0 } };
  const outcome = await caseRungs({ ...rc, best, against: { ...rc.against, head: best.head } }, scope, built);
  const decision = outcome.verdict === "kept" ? "kept" : "rejected";
  return { ...started, merge, l0, runs: outcome.runs, delta: outcome.delta, decision, reason: outcome.reason };
}

/** A conflict, or a host with no integrate port, sends the winner back to the queue rather than keeping its solo run. */
async function reevaluate(rc: RoundContext, idea: Idea, winner: Outcome, best: Best): Promise<Reeval> {
  const started = { ideaId: idea.id, from: rc.best.head, vs: best.head };
  const input = { runId: rc.ctx.runId, tree: rc.pinned.integrationTree, base: best.head, head: winner.head!, message: `ar: merge ${idea.id} onto ${best.head}` };
  const integrated = await step(rc.ctx, `${arStepId("integrate")}:${rc.round}/${idea.id}`, input, IntegrateResultSchema);
  if ("skipped" in integrated) return { ...started, merge: null, runs: [], decision: "requeued", reason: integrated.skipped };
  if ("conflict" in integrated) return { ...started, merge: null, conflict: integrated.conflict, runs: [], decision: "requeued", reason: "conflict" };
  return measureMerge(rc, idea, winner, best, integrated.merged, started);
}

/** Each later winner in pick order, each against the B the one before it left; a keep moves the ratchet onto its merge. */
async function settleLater(rc: RoundContext, ideas: ReadonlyMap<string, Idea>, later: readonly Outcome[], first: Best, moves: Move[]) {
  let best = first;
  const reevals: Reeval[] = [];
  for (const winner of later) {
    const reeval = await reevaluate(rc, ideas.get(winner.ideaId)!, winner, best);
    reevals.push(await recorded(rc.ctx, `${arStepId("reeval")}:${rc.round}/${winner.ideaId}`, ReevalSchema, () => reeval));
    if (reeval.decision !== "kept") continue;
    // The keep rule only accepts at L3, so a kept re-evaluation always reached it.
    const evidence = { ideaId: winner.ideaId, keepRung: "L3", delta: reeval.delta ?? 0, runs: reeval.runs };
    best = { head: await moveRatchet(rc, moves, ratchetRequest(rc, evidence, { from: best.head, to: reeval.merge!, kind: "merge" })), runs: reeval.runs };
  }
  return { best, reevals };
}

/** The round's winners in `pickWinner` order: the first fast-forwards the ratchet, the rest are re-evaluated on top of it. */
export async function settleWinners(rc: RoundContext, ideas: ReadonlyMap<string, Idea>, outcomes: readonly Outcome[]): Promise<Moved> {
  const [first, ...later] = pickWinner(outcomes.filter((outcome) => outcome.verdict === "kept"), rc.band.sigma);
  if (!first) return { best: rc.best, kept: [], superseded: [], moves: [], reevals: [], requeue: [] };
  const moves: Move[] = [];
  const evidence = { ideaId: first.ideaId, keepRung: first.rungReached, delta: first.delta ?? 0, runs: first.runs };
  const head = await moveRatchet(rc, moves, ratchetRequest(rc, evidence, { from: rc.best.head, to: first.head!, kind: "ff" }));
  const { best, reevals } = await settleLater(rc, ideas, later, { head, runs: first.runs }, moves);
  const idsOf = (decision: Reeval["decision"]) => reevals.filter((reeval) => reeval.decision === decision).map((reeval) => reeval.ideaId);
  const superseded = idsOf("requeued");
  const requeue = superseded.map((ideaId) => ({ ...ideas.get(ideaId)!, source: "requeue" as const, round: rc.round + 1 }));
  return { best, kept: [first.ideaId, ...idsOf("kept")], superseded, moves, reevals, requeue };
}
