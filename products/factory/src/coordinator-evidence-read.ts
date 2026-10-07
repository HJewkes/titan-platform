import { GITHUB_ACTIONS_APP_ID, headCheckFindings, isPassing, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { GateRecord, GateResolver } from "@titan-design/hitl";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import {
  MAIN_GATES,
  MERGE_GATE,
  PR_GATES,
  coordinatorEvidencePolicy,
  gatePr,
  landGate,
  mainGate,
  mergeableOf,
  offersAbandon,
  stepOf,
  type CheckRunFact,
  type CoordinatorEvidence,
  type LandGate,
  type RunFacts,
} from "./coordinator-evidence.js";
import type { FactoryHost } from "./host.js";
import type { ShepherdServices } from "./shepherd/commands.js";
import { readRequiredChecks } from "./required-checks.js";
import { actionsRunsAt, withoutSupersededCancels } from "./shepherd/freeze.js";
import { gatedRule } from "./shepherd/head-moved.js";
import { EffectivePolicySchema, OWNER_GATE_POLICY, stricterPolicy, type EffectivePolicy } from "./shepherd/policy.js";

/** Where the fresh reads come from: GitHub through the port, and the factory's own registration and freeze rows. */
export interface EvidenceSources {
  port: GitHubPort;
  registration(runId: string): { repo: RepoSlug; pr: number | null; policy: EffectivePolicy; held: boolean } | undefined;
  frozen(repo: RepoSlug): boolean;
  now(): number;
}

type Payload = Record<string, unknown>;

/**
 * Reads, fresh, the evidence that lets a coordinator give `payload` to the pending gate `gateId`, and returns it only
 * when the store's own policy would admit it. Any failed or partial read is undefined, so the caller falls back to
 * asking for the owner's presence.
 */
export async function readCoordinatorEvidence(host: FactoryHost, sources: EvidenceSources, gateId: string, payload: Payload, resolver: GateResolver): Promise<CoordinatorEvidence | undefined> {
  try {
    const gate = host.gates.get(gateId);
    const run = host.runtime.status(gateId.slice(0, gateId.indexOf("/")));
    if (gate?.status !== "pending" || !run) return undefined;
    const evidence = await readFor(sources, gate, run, payload);
    return evidence && coordinatorEvidencePolicy(gate, resolver, payload, evidence) ? evidence : undefined;
  } catch {
    return undefined;
  }
}

function readFor(sources: EvidenceSources, gate: GateRecord, run: WorkflowRun, payload: Payload): Promise<CoordinatorEvidence | undefined> | undefined {
  const step = stepOf(gate.id);
  if (step === MERGE_GATE && payload.decision === "merge") return readMerge(sources, gate, run, payload);
  if (Object.hasOwn(MAIN_GATES, step)) return readMainGreen(sources, gate);
  if (PR_GATES.has(step) && payload.decision === "abandon") return readPrGone(sources, gate, run);
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
  return { workflow: run.workflowName, repo, pr, rule: `${rule.table}/${rule.rowId}`, merge: policy.merge, visualPaths: policy.visualPaths !== undefined, held, frozen: sources.frozen(land.repo) };
}

function runPolicy(run: WorkflowRun): EffectivePolicy {
  const raw = run.params.policy;
  return raw === undefined ? OWNER_GATE_POLICY : EffectivePolicySchema.parse(JSON.parse(raw));
}

const VerdictRecord = z.looseObject({ kind: z.literal("verdict"), verdict: z.string(), head: z.string(), reviewer: z.looseObject({ agentId: z.string() }) });

/** The reviewer's verdict recorded at exactly this head; a correction or retry at the head must agree, or there is none. */
function verdictAt(run: WorkflowRun, head: string): { step: string; verdict: string; head: string; reviewer: string } | undefined {
  const step = `sh-await-verdict:${head}`;
  const results = Object.values(run.stepResults).filter((result) => result.stepId === step || result.stepId.startsWith(`${step}:`));
  const records = results.map((result) => VerdictRecord.safeParse(result.data?.result));
  const base = records[results.findIndex((result) => result.stepId === step)];
  if (!base?.success || !records.every((record) => record.success && record.data.verdict === "MERGE" && record.data.head === head)) return undefined;
  return { step, verdict: base.data.verdict, head: base.data.head, reviewer: base.data.reviewer.agentId };
}

/** Every required context of the base has a successful Actions run at the head, and no counted run there is red or pending. */
async function requiredGreenAt(port: GitHubPort, repo: RepoSlug, base: string, head: string): Promise<{ base: string; required: string[]; runs: CheckRunFact[] } | undefined> {
  const read = await readRequiredChecks(port, repo, base);
  if (!read.readable || read.checks.contexts.length === 0) return undefined;
  const { contexts } = read.checks;
  const runs = await port.checkRuns(repo, head);
  if (headCheckFindings({ headSha: head, contexts, runs, requiredApps: [GITHUB_ACTIONS_APP_ID] }).length > 0) return undefined;
  const required = contexts.map((name) => runs.find((run) => run.name === name && run.headSha === head && run.appId === GITHUB_ACTIONS_APP_ID && run.conclusion === "success"));
  if (required.some((run) => run === undefined)) return undefined;
  return { base, required: contexts, runs: (required as CheckRun[]).map(runFact) };
}

/** The base branch's tip, when it contains the merge sha and every Actions run on it passed. */
async function readMainGreen(sources: EvidenceSources, gate: GateRecord): Promise<CoordinatorEvidence | undefined> {
  const main = mainGate(gate);
  if (!main) return undefined;
  const { port } = sources;
  const pull = await port.getPr(main.repo, main.pr);
  const tip = pull.merged && pull.mergeSha === main.mergeSha ? await port.getHeadSha(main.repo, pull.baseRef) : null;
  if (!tip) return undefined;
  const mergeBaseSha = tip === main.mergeSha ? tip : (await port.compareFiles(main.repo, main.mergeSha, tip)).mergeBaseSha;
  const runs = withoutSupersededCancels(actionsRunsAt(await port.checkRuns(main.repo, tip), tip));
  if (mergeBaseSha !== main.mergeSha || runs.length === 0 || !runs.every(isPassing)) return undefined;
  return { kind: "main-green", gateId: gate.id, ...main, base: pull.baseRef, greenSha: tip, mergeBaseSha, runs: runs.map(runFact), readAt: readAt(sources) };
}

async function readPrGone(sources: EvidenceSources, gate: GateRecord, run: WorkflowRun): Promise<CoordinatorEvidence | undefined> {
  const target = gatePr(gate);
  const registration = sources.registration(run.id);
  const runPr = run.params.pr === undefined ? registration?.pr : Number(run.params.pr);
  if (!target || !offersAbandon(gate) || run.params.repo !== target.repo || runPr !== target.pr) return undefined;
  const land = stepOf(gate.id) === MERGE_GATE ? landGate(gate) : undefined;
  const facts = land && runFacts(sources, run, gate, land);
  if (stepOf(gate.id) === MERGE_GATE && !facts) return undefined;
  const pull = await sources.port.getPr(target.repo, target.pr);
  const state = pull.merged ? "merged" : pull.state === "closed" ? "closed" : undefined;
  if (!state) return undefined;
  return { kind: "pr-gone", gateId: gate.id, ...target, state, ...(facts && { run: facts }), readAt: readAt(sources) };
}

function runFact({ id, name, conclusion, headSha }: CheckRun): CheckRunFact {
  return { id, name, conclusion: conclusion ?? "none", headSha };
}

const readAt = (sources: EvidenceSources): string => new Date(sources.now()).toISOString();

/** The live sources: Shepherd's port, registration store and freeze store; an unbound freeze store throws, which reads as no evidence. */
export function evidenceSources(services: ShepherdServices): EvidenceSources {
  return {
    port: services.port,
    registration: (runId) => services.store.get().byRun(runId),
    frozen: (repo) => services.freeze?.get().isFrozen(repo) ?? false,
    now: Date.now,
  };
}
