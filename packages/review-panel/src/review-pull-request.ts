import type { LineSource } from "@titan-design/evidence";
import { acceptVerdict, isUsageLimit } from "./accept-verdict.js";
import { aggregate, type MemberResult } from "./aggregate.js";
import { shapeBrief, type ShapeBriefInput } from "./briefs/shape-brief.js";
import { classifyPr, type ClassRules } from "./classify.js";
import { DEFAULT_PANEL_POLICY, DEFAULT_SONNET_FOR, planPanel, type Headroom, type PanelPolicy } from "./plan.js";
import type { AwaitVerdictInput, ReviewTarget, ReviewerAgent, ReviewerDispatch, ReviewerReader } from "./ports.js";
import { correctionPrompt, reviewerBrief } from "./reviewer-brief.js";
import type { PanelMember, PanelVerdict, PrFacts, ReviewShape } from "./types.js";
import { readMalformed } from "./verdict-schemas.js";

export interface ReviewRequest {
  facts: PrFacts;
  /** Everything the briefs carry except the target, which `facts` names. */
  brief: Omit<ShapeBriefInput, "repo" | "pr" | "head">;
  /** File text at the head, for the aggregate's citation check. */
  source: LineSource;
  /** Absent means `DEFAULT_PANEL_POLICY`. */
  policy?: PanelPolicy;
  /** Absent means `DEFAULT_CLASS_RULES`. */
  rules?: ClassRules;
}

export interface ReviewClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ReviewPorts {
  dispatch: ReviewerDispatch;
  reader: ReviewerReader;
  clock: ReviewClock;
  /** Asked once, before planning. */
  headroom(): Promise<Headroom>;
}

export interface ReviewOptions {
  pollMs?: number;
  /** How long a member's session may take to start, from its spawn. */
  startDeadlineMs?: number;
  /** How long a started member may take to write its verdict. */
  verdictDeadlineMs?: number;
}

/** Why a member has no verdict when the dispatch refused it at its profile and at any sonnet fallback. */
export const SPAWN_REFUSED_REASON = "the dispatch refused to spawn the reviewer";

const DEFAULT_OPTIONS: Required<ReviewOptions> = { pollMs: 30_000, startDeadlineMs: 10 * 60_000, verdictDeadlineMs: 60 * 60_000 };

type Outcome = MemberResult["result"];

interface Run {
  request: ReviewRequest;
  ports: ReviewPorts;
  opts: Required<ReviewOptions>;
  target: ReviewTarget;
  sonnetFor: Record<string, string>;
}

interface MemberState {
  member: PanelMember;
  /** One correction per member, across both attempts. */
  corrected: boolean;
  degraded: boolean;
}

/** A pure function of the input, so a repeat call finds the same roster row; attempt 2 is the fresh retry of a silent member. */
export function memberName(target: ReviewTarget, shape: ReviewShape, attempt: 1 | 2 = 1): string {
  const base = `rp-${target.repo.replaceAll("/", "-")}-${target.pr}-${target.head.slice(0, 8)}-${shape}`;
  return attempt === 2 ? `${base}-r2` : base;
}

const sonnetOf = (run: Run, profile: string): string | undefined => (Object.hasOwn(run.sonnetFor, profile) ? run.sonnetFor[profile] : undefined);

function briefFor(run: Run, shape: ReviewShape): string {
  const input = { ...run.request.brief, ...run.target };
  return shape === "correctness" ? reviewerBrief(input) : shapeBrief(shape, input);
}

async function rowNamed(run: Run, name: string): Promise<ReviewerAgent | undefined> {
  return (await run.ports.dispatch.roster()).find((row) => row.name === name);
}

/** An opus member the dispatch refuses is spawned once more at its sonnet profile and marked degraded. */
async function spawnMember(run: Run, state: MemberState, name: string): Promise<boolean> {
  const brief = briefFor(run, state.member.shape);
  const kind = run.request.facts.kind;
  const spawnAt = (profile: string) => run.ports.dispatch.spawn(name, brief, run.target, { ...(kind !== undefined && { kind }), profile });
  const ok = (profile: string) => spawnAt(profile).then(() => true, () => false);
  if (await ok(state.member.profile)) return true;
  const sonnet = sonnetOf(run, state.member.profile);
  if (sonnet === undefined || !(await ok(sonnet))) return false;
  state.degraded = true;
  return true;
}

/** Polls the roster until the named row has a session; an unreadable roster counts as not yet. */
async function awaitStart(run: Run, name: string, dispatchedAt: number): Promise<AwaitVerdictInput | undefined> {
  const { clock } = run.ports;
  const end = clock.now() + run.opts.startDeadlineMs;
  for (;;) {
    const row = await rowNamed(run, name).catch(() => undefined);
    if (row && row.sessionId !== "") return { ...run.target, reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt, startedAt: clock.now() };
    if (clock.now() >= end) return undefined;
    await clock.sleep(run.opts.pollMs);
  }
}

/** A row already under this name is reused and nothing is spawned; its dispatch time is 0 because the name already pins the head. */
async function startMember(run: Run, state: MemberState, name: string): Promise<AwaitVerdictInput | Outcome> {
  const existing = await rowNamed(run, name);
  if (existing) {
    if (existing.profile !== undefined && existing.profile === sonnetOf(run, state.member.profile)) state.degraded = true;
    return (await awaitStart(run, name, 0)) ?? { kind: "timeout" };
  }
  const dispatchedAt = run.ports.clock.now();
  if (!(await spawnMember(run, state, name))) return { kind: "none", reason: SPAWN_REFUSED_REASON };
  return (await awaitStart(run, name, dispatchedAt)) ?? { kind: "timeout" };
}

/** A malformed final message ends the wait at once, since the reviewer's turn is over; WAIT and silence keep it going. */
async function awaitMember(run: Run, input: AwaitVerdictInput): Promise<Outcome> {
  const { clock, reader } = run.ports;
  const end = clock.now() + run.opts.verdictDeadlineMs;
  for (;;) {
    const result = acceptVerdict(input, await reader.read(input).catch(() => []));
    if (result.kind === "verdict" || isUsageLimit(result) || readMalformed(result)) return result;
    if (clock.now() >= end) return { kind: "timeout" };
    await clock.sleep(run.opts.pollMs);
  }
}

async function correctOnce(run: Run, state: MemberState, name: string, result: Outcome): Promise<Outcome> {
  const malformed = readMalformed(result);
  if (!malformed || state.corrected) return result;
  state.corrected = true;
  const dispatchedAt = run.ports.clock.now();
  const prompt = correctionPrompt({ ...run.target, refusal: malformed.refusal, ...(malformed.quotes && { quotes: malformed.quotes }), ...(run.request.brief.ownerBrief && { ownerBrief: true }) });
  if (!(await run.ports.dispatch.resume(name, prompt).then(() => true, () => false))) return result;
  const input = await awaitStart(run, name, dispatchedAt);
  return input ? awaitMember(run, input) : { kind: "timeout" };
}

async function attempt(run: Run, state: MemberState, n: 1 | 2): Promise<Outcome> {
  const name = memberName(run.target, state.member.shape, n);
  const started = await startMember(run, state, name);
  if ("kind" in started) return started;
  return correctOnce(run, state, name, await awaitMember(run, started));
}

/** A verdict, a usage limit and a refused spawn are final; silence or an uncorrected reply gets one fresh reviewer. */
const settled = (result: Outcome): boolean => result.kind === "verdict" || isUsageLimit(result) || (result.kind === "none" && result.reason === SPAWN_REFUSED_REASON);

async function reviewMember(run: Run, member: PanelMember): Promise<MemberResult> {
  const state: MemberState = { member, corrected: false, degraded: false };
  const first = await attempt(run, state, 1);
  const result = settled(first) ? first : await attempt(run, state, 2);
  return { shape: member.shape, result, ...(state.degraded && { degraded: true }) };
}

/**
 * Classifies, plans, runs every member in parallel and aggregates. Each member is spawned under `memberName`, so a repeat
 * call with the same input reuses the roster rows and spawns nothing.
 */
export async function reviewPullRequest(request: ReviewRequest, ports: ReviewPorts, opts: ReviewOptions = {}): Promise<PanelVerdict> {
  const policy = request.policy ?? DEFAULT_PANEL_POLICY;
  const sonnetFor = policy.sonnetFor ?? DEFAULT_SONNET_FOR;
  const plan = planPanel(classifyPr(request.facts, request.rules), policy, await ports.headroom());
  const { repo, pr, head } = request.facts;
  const run: Run = { request, ports, opts: { ...DEFAULT_OPTIONS, ...opts }, target: { repo, pr, head }, sonnetFor };
  const results = await Promise.all(plan.members.map((member) => reviewMember(run, member)));
  const { fixProof, fixProofWaivedAt } = request.brief;
  return aggregate(plan, results, { head, source: request.source, sonnetFor, ...(fixProof !== undefined && { fixProof }), ...(fixProofWaivedAt !== undefined && { fixProofWaivedAt }) });
}
