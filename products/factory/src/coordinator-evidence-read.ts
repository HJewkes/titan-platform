import { GITHUB_ACTIONS_APP_ID, headCheckFindings, withoutSupersededCancels, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { GateRecord, GateResolver } from "@titan-design/hitl";
import type { WorkflowRun } from "@titan-design/workflow";
import { verdictAt } from "./verdict-at.js";
import { MERGE_UP_APPROVAL, gateMayFollowHead } from "./merge-up-approval.js";
import { readMergeUpChain, type MergeUpChain, type MergeUpChainInput } from "./merge-up-chain.js";
import { readPath } from "./narrow.js";
import {
  AWAIT_NEW_HEAD,
  DEAD_END_GATE,
  MAIN_CI_TIMEOUT,
  MAIN_GATES,
  MERGE_GATE,
  PR_GATES,
  SEAT_DEAD_END_ANSWERS,
  SENT_BACK_GATE,
  coordinatorEvidencePolicy,
  gatePr,
  landGate,
  mainGate,
  mergeableOf,
  offersAbandon,
  ownerAtHeadRow,
  stepOf,
  type CheckRunFact,
  type CoordinatorEvidence,
  type LandGate,
  type MainMerge,
  type RunFacts,
} from "./coordinator-evidence.js";
import type { FactoryHost } from "./host.js";
import type { ShepherdServices } from "./shepherd/services.js";
import { readRequiredChecks } from "./required-checks.js";
import { actionsRunsAt } from "./shepherd/freeze.js";
import { judgeMain, readMainRules } from "./shepherd/main-verdict.js";
import { gatedRule } from "./shepherd/head-moved.js";
import { addressedSeat } from "./shepherd/dead-end.js";
import { landGateBase } from "./shepherd/approval-carry.js";
import { headGateAsks } from "./shepherd/stale-gates.js";
import { runPolicyCeiling } from "./shepherd/policy.js";
import { stricterPolicy, type EffectivePolicy } from "./shepherd/policy-schema.js";

/** Where the fresh reads come from: GitHub through the port, and the factory's own registration and freeze rows. */
export interface EvidenceSources {
  port: GitHubPort;
  registration(runId: string): { repo: RepoSlug; pr: number | null; policy: EffectivePolicy; held: boolean } | undefined;
  frozen(repo: RepoSlug): boolean;
  now(): number;
  /** Walks the merge-ups between two heads from a fresh fetch; without it no merge-up approval is read. */
  mergeUpChain?(input: MergeUpChainInput): Promise<MergeUpChain>;
}

type Payload = Record<string, unknown>;

/**
 * Reads, fresh, the evidence that lets a coordinator give `payload` to the pending gate `gateId`, and returns it only
 * when the store's own policy would admit it. Any failed or partial read is undefined, so the caller falls back to
 * asking for the owner's presence. A merge the run's own facts do not admit may still follow the owner's earlier
 * approval across clean merge-ups; why that read refused goes to `onRefusal`.
 */
export async function readCoordinatorEvidence(
  host: FactoryHost,
  sources: EvidenceSources,
  gateId: string,
  payload: Payload,
  resolver: GateResolver,
  onRefusal?: (reason: string) => void,
): Promise<CoordinatorEvidence | undefined> {
  try {
    const gate = host.gates.get(gateId);
    const run = host.runtime.status(gateId.slice(0, gateId.indexOf("/")));
    if (gate?.status !== "pending" || !run) return undefined;
    const evidence = await readFor(sources, gate, run, payload);
    if (evidence && coordinatorEvidencePolicy(gate, resolver, payload, evidence)) return evidence;
    const mergeUp = stepOf(gate.id) === MERGE_GATE && payload.decision === "merge" ? await readMergeUpApproval(host, sources, gate, onRefusal) : undefined;
    return mergeUp && coordinatorEvidencePolicy(gate, resolver, payload, mergeUp) ? mergeUp : undefined;
  } catch {
    onRefusal?.("no coordinator evidence: a read failed");
    return undefined;
  }
}

type Approval = Extract<CoordinatorEvidence, { kind: "merge-up-approval" }>["approval"];

/**
 * The owner's merge answer the gate's head may follow from: the newest answered land gate of the run before this one, when
 * an owner class answered `merge` at the head it asked, on the same PR and base. A coordinator's merge that itself followed
 * merge-ups leads back to that answer; any other answer, an escalation or a D21 gate ends the search with none.
 */
function ownerApproval(host: FactoryHost, gate: GateRecord, land: LandGate, base: string): Approval | undefined {
  for (const prior of earlierLandGates(host, gate.id)) {
    if (prior.status !== "resolved") continue;
    const asked = landGate(prior);
    const ownerAtHead = ownerAtHeadRow(prior);
    const merged = readPath(prior.payload, "decision") === "merge" && readPath(prior.payload, "headSha") === asked?.head;
    if (!asked || !merged || !gateMayFollowHead(asked.rule, ownerAtHead) || asked.repo !== land.repo || asked.pr !== land.pr || landGateBase(prior.prompt) !== base) return undefined;
    const by = prior.resolvedBy?.class ?? "";
    if (MERGE_UP_APPROVAL.approvedBy.includes(by)) return { gateId: prior.id, head: asked.head, resolverClass: by, rule: asked.rule, ownerAtHead: null };
    if (by !== "coordinator" || readPath(prior.resolvedEvidence, "kind") !== "merge-up-approval") return undefined;
  }
  return undefined;
}

/** The run's land gates before `gateId`, newest first: land asks at `approve-merge`, then `approve-merge:1`, `:2` and on. */
function earlierLandGates(host: FactoryHost, gateId: string): GateRecord[] {
  const first = gateId.replace(/:\d+$/, "");
  const gates: GateRecord[] = [];
  let next = host.gates.get(first);
  for (let n = 1; next !== undefined && next.id !== gateId; n += 1) {
    gates.unshift(next);
    next = host.gates.get(`${first}:${n}`);
  }
  return gates;
}

/** Rule 461 under decision 556(3): the PR open at the gated head, only clean merge-ups since the owner's approved head, and CI green. */
async function readMergeUpApproval(host: FactoryHost, sources: EvidenceSources, gate: GateRecord, onRefusal?: (reason: string) => void): Promise<CoordinatorEvidence | undefined> {
  const refuse = (reason: string): undefined => void onRefusal?.(`no merge-up approval: ${reason}`);
  const land = landGate(gate);
  const base = landGateBase(gate.prompt);
  if (!land || base === undefined || !sources.mergeUpChain) return refuse("the gate names no land head and base, or no git reader is bound");
  const ownerAtHead = ownerAtHeadRow(gate);
  if (!gateMayFollowHead(land.rule, ownerAtHead)) return refuse(`the gate is ${ownerAtHead ?? land.rule}, which the owner answers at its own head`);
  const approval = ownerApproval(host, gate, land, base);
  if (!approval) return refuse("no owner merge answer on an earlier land gate of this run");
  const pull = await sources.port.getPr(land.repo, land.pr);
  if (pull.state !== "open" || pull.merged || pull.headSha !== land.head || pull.baseRef !== base) return refuse(`the PR is not open at ${land.head} on ${base}`);
  const chain = await sources.mergeUpChain({ repo: land.repo, baseRef: base, fromHead: approval.head, head: land.head });
  if (!chain.ok) return refuse(chain.reason);
  const checks = await requiredGreenAt(sources.port, land.repo, base, land.head);
  if (!checks) return refuse(`the required checks are not green at ${land.head}`);
  return {
    ...{ kind: "merge-up-approval", gateId: gate.id, repo: land.repo, pr: land.pr, headSha: land.head, base, approval, mergeUps: chain.commits, checks },
    ...{ pull: { state: pull.state, headSha: pull.headSha, baseRef: pull.baseRef }, readAt: readAt(sources) },
  };
}

function readFor(sources: EvidenceSources, gate: GateRecord, run: WorkflowRun, payload: Payload): Promise<CoordinatorEvidence | undefined> | undefined {
  const step = stepOf(gate.id);
  if (step === MERGE_GATE && payload.decision === "merge") return readMerge(sources, gate, run, payload);
  if (Object.hasOwn(MAIN_GATES, step)) return readMainGreen(sources, gate);
  if (step === DEAD_END_GATE && SEAT_DEAD_END_ANSWERS.has(String(payload.decision))) return readSeatDeadEnd(sources, gate, run, payload);
  if (PR_GATES.has(step) && payload.decision === "abandon") return readPrGone(sources, gate, run);
  if (step === SENT_BACK_GATE && payload.decision === AWAIT_NEW_HEAD) return readPrAtHead(sources, gate, run);
  return undefined;
}

async function readMerge(sources: EvidenceSources, gate: GateRecord, run: WorkflowRun, payload: Payload): Promise<CoordinatorEvidence | undefined> {
  const land = landGate(gate);
  const facts = land && runFacts(sources, run, gate, land);
  const verdict = land && verdictAt(run, land.head);
  if (!land || !facts || !verdict || payload.headSha !== land.head) return undefined;
  const pull = await sources.port.getPr(land.repo, land.pr);
  if (pull.state !== "open" || pull.merged || pull.draft || pull.headSha !== land.head) return undefined;
  const checks = await requiredGreenAt(sources.port, land.repo, pull.baseRef, land.head);
  if (!checks) return undefined;
  const { mergeableState } = pull;
  return {
    ...{ kind: "approve-merge", gateId: gate.id, repo: land.repo, pr: land.pr, headSha: land.head, run: facts, verdict, checks },
    ...{ pull: { state: pull.state, headSha: pull.headSha, mergeableState, mergeable: mergeableOf(mergeableState) }, readAt: readAt(sources) },
  };
}

/** The run's own record of the gate: its registration, the rule it decided at the head, and whether it is held or frozen. */
function runFacts(sources: EvidenceSources, run: WorkflowRun, gate: GateRecord, land: LandGate): RunFacts | undefined {
  const registration = sources.registration(run.id);
  const rule = gatedRule(run, gate.prompt);
  if (!registration || registration.pr === null || !rule) return undefined;
  const policy = stricterPolicy(registration.policy, runPolicy(run));
  const { repo, pr, held } = registration;
  return { workflow: run.workflowName, repo, pr, rule: `${rule.table}/${rule.rowId}`, reason: rule.reason, merge: policy.merge, visualPaths: policy.visualPaths !== undefined, held, frozen: sources.frozen(land.repo) };
}

function runPolicy(run: WorkflowRun): EffectivePolicy {
  return runPolicyCeiling(run.params.policy);
}

/** Every required context of the base has a successful Actions run at the head, and no counted run there is red or pending. */
async function requiredGreenAt(port: GitHubPort, repo: RepoSlug, base: string, head: string): Promise<{ base: string; required: string[]; runs: CheckRunFact[] } | undefined> {
  const read = await readRequiredChecks(port, repo, base);
  if (!read.readable || read.checks.contexts.length === 0) return undefined;
  const { contexts } = read.checks;
  const runs = await port.checkRuns(repo, head);
  if (headCheckFindings({ headSha: head, contexts, runs, requiredApps: [GITHUB_ACTIONS_APP_ID] }).length > 0) return undefined;
  const required = contexts.map((name) => runs.find((run) => run.name === name && run.headSha === head && run.appId === GITHUB_ACTIONS_APP_ID && run.conclusion === "success"));
  const found = required.filter((run) => run !== undefined);
  if (found.length !== required.length) return undefined;
  return { base, required: contexts, runs: found.map(runFact) };
}

type ChecksState = "green" | "failing" | "pending" | "unreadable";

/** What the required checks of the base say about the head, for a human to read; a failing run outranks a pending one. */
export async function checksAt(port: GitHubPort, repo: RepoSlug, base: string, head: string): Promise<{ state: ChecksState; failing: string[] }> {
  const read = await readRequiredChecks(port, repo, base);
  if (!read.readable || read.checks.contexts.length === 0) return { state: "unreadable", failing: [] };
  const runs = await port.checkRuns(repo, head);
  const findings = headCheckFindings({ headSha: head, contexts: read.checks.contexts, runs, requiredApps: [GITHUB_ACTIONS_APP_ID] });
  const failing = [...new Set(findings.flatMap((finding) => (finding.kind === "failed" ? [finding.run.name] : [])))];
  if (failing.length > 0) return { state: "failing", failing };
  return { state: findings.length > 0 ? "pending" : "green", failing: [] };
}

/** A main-ci-timeout gate asks the question Shepherd's own clear answers, so it needs the same required contexts. */
function readMainGreen(sources: EvidenceSources, gate: GateRecord): Promise<CoordinatorEvidence | undefined> | undefined {
  const main = mainGate(gate);
  return main && mainGreenAt(sources, gate.id, main, { required: stepOf(gate.id) === MAIN_CI_TIMEOUT });
}

export type MainGreenEvidence = Extract<CoordinatorEvidence, { kind: "main-green" }>;

/**
 * The base branch's tip, when it contains the merge sha and every check that judges main passed: the required contexts when
 * the base has them, else every Actions run. With `required`, a base with no readable required contexts is no evidence.
 */
export async function mainGreenAt(sources: Pick<EvidenceSources, "port" | "now">, gateId: string, main: MainMerge, { required }: { required: boolean }): Promise<MainGreenEvidence | undefined> {
  const { port } = sources;
  const pull = await port.getPr(main.repo, main.pr);
  const tip = pull.merged && pull.mergeSha === main.mergeSha ? await port.getHeadSha(main.repo, pull.baseRef) : null;
  if (!tip) return undefined;
  const mergeBaseSha = tip === main.mergeSha ? tip : (await port.compareFiles(main.repo, main.mergeSha, tip)).mergeBaseSha;
  const all = await port.checkRuns(main.repo, tip);
  const { rules } = await readMainRules(port, main.repo, pull.baseRef);
  if (required && rules === undefined) return undefined;
  const judged = judgeMain(tip, all, rules);
  if (mergeBaseSha !== main.mergeSha || judged.counted === 0 || judged.findings.length > 0) return undefined;
  const runs = withoutSupersededCancels(actionsRunsAt(all, tip)).filter((run) => rules === undefined || rules.contexts.includes(run.name));
  return { kind: "main-green", gateId, ...main, base: pull.baseRef, greenSha: tip, mergeBaseSha, runs: runs.map(runFact), readAt: readAt(sources) };
}

/** The PR the gate names, when it is the run's own PR. */
function runsPr(sources: EvidenceSources, gate: GateRecord, run: WorkflowRun): { repo: string; pr: number } | undefined {
  const target = gatePr(gate);
  const registration = sources.registration(run.id);
  const runPr = run.params.pr === undefined ? registration?.pr : Number(run.params.pr);
  return target && run.params.repo === target.repo && runPr === target.pr ? target : undefined;
}

async function readPrGone(sources: EvidenceSources, gate: GateRecord, run: WorkflowRun): Promise<CoordinatorEvidence | undefined> {
  const target = runsPr(sources, gate, run);
  if (!target || !offersAbandon(gate)) return undefined;
  const pull = await sources.port.getPr(target.repo, target.pr);
  const state = pull.merged ? "merged" : pull.state === "closed" ? "closed" : undefined;
  if (!state) return undefined;
  return { kind: "pr-gone", gateId: gate.id, ...target, state, readAt: readAt(sources) };
}

/** Records the PR's state and head as read; the policy alone compares them with the gate's head, so an audit re-runs the same check. */
async function readPrAtHead(sources: EvidenceSources, gate: GateRecord, run: WorkflowRun): Promise<CoordinatorEvidence | undefined> {
  const target = runsPr(sources, gate, run);
  if (!target) return undefined;
  const pull = await sources.port.getPr(target.repo, target.pr);
  const state = pull.merged ? "merged" : pull.state === "open" ? "open" : "closed";
  return { kind: "pr-at-head", gateId: gate.id, ...target, state, headSha: pull.headSha, readAt: readAt(sources) };
}

/** A gone PR's abandon reads as pr-gone; otherwise the seat the run recorded for this head, and the PR as read now. */
async function readSeatDeadEnd(sources: EvidenceSources, gate: GateRecord, run: WorkflowRun, payload: Payload): Promise<CoordinatorEvidence | undefined> {
  const target = runsPr(sources, gate, run);
  const head = headGateAsks(gate);
  const seat = head && addressedSeat(run, head);
  if (!target || !seat) return undefined;
  const pull = await sources.port.getPr(target.repo, target.pr);
  const state = pull.merged ? "merged" : pull.state === "open" ? "open" : "closed";
  if (state !== "open" && payload.decision === "abandon") return { kind: "pr-gone", gateId: gate.id, ...target, state, readAt: readAt(sources) };
  return { kind: "seat-dead-end", gateId: gate.id, ...target, headSha: head, seat, pull: { state, headSha: pull.headSha }, readAt: readAt(sources) };
}

function runFact({ id, name, conclusion, headSha }: CheckRun): CheckRunFact {
  return { id, name, conclusion: conclusion ?? "none", headSha };
}

const readAt = (sources: Pick<EvidenceSources, "now">): string => new Date(sources.now()).toISOString();

/** The live sources: Shepherd's port, registration store and freeze store; an unbound freeze store throws, which reads as no evidence. */
export function evidenceSources(services: ShepherdServices): EvidenceSources {
  return {
    port: services.port,
    registration: (runId) => services.store.get().byRun(runId),
    frozen: (repo) => services.freeze?.get().isFrozen(repo) ?? false,
    now: Date.now,
    mergeUpChain: (input) => readMergeUpChain(input),
  };
}
