import { DEFAULT_TABLE, unmetConditions, type CheckRunFact, type MergeFacts, type OwnerGateFact } from "@titan-design/authority";
import { latestPerName, type CheckRun, type GitHubPort, type PullRequest } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import type { ByRecSubject } from "@titan-design/owner-queue";
import type { WorkflowRun } from "@titan-design/workflow";
import { landGate, mergeableOf, ownerAtHeadRow, type LandGate } from "../coordinator-evidence.js";
import { decisionClassOf } from "../decision-class.js";
import type { FactoryHost, PendingGate } from "../host.js";
import { readRequiredChecks } from "../required-checks.js";
import { verdictAt } from "../verdict-at.js";
import { withoutEditRunSkips } from "./fix-proof-jobs.js";
import { holdClassOf } from "./g10-release.js";
import { gatedRule } from "./head-moved.js";
import { OWNER_HOLD_CLASS } from "./hold-reason.js";
import { MERGE_EVIDENCE_STEP } from "./merge-facts.js";
import { pinnedPaths } from "./pr-changed-paths.js";
import { MergeEvidenceSchema } from "./review-schemas.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./services.js";
import type { Registration } from "./store.js";

export const BY_REC_RULE = "MRG-AU-RB";
const MERGE_OPTION = "merge";
const DOOR = /^Door: (one-way|two-way)$/m;

/**
 * The gates a by-rec merge may stand in for: authority's own MRG-AU gate (D4) and a visual approve-merge gate (D2), which
 * the owner included on purpose. Every other rule (route escalations, release, guard rows, a seat's plain owner gate) stays
 * with the owner.
 */
const ELIGIBLE = new Map([["authority/MRG-AU", "D4"], ["shepherd-merge-guard/visual-path", "D2"]]);

export type ByRecReads = { host: Pick<FactoryHost, "runtime">; services: Pick<ShepherdServices, "store" | "port" | "freeze"> };

/** What the sweep read about one gate: the subject for the policy, the facts for MRG-AU-RB, and the row's record of both. */
export interface ByRecRead {
  subject: ByRecSubject;
  merge: MergeFacts;
  /** MRG-AU-RB's conditions that did not hold on `merge`; empty means the row allows. */
  unmet: string[];
  land: LandGate;
  reviewer: string;
}

export type ByRecReadResult = ByRecRead | { skip: string };

interface Known {
  gate: GateRecord;
  run: WorkflowRun;
  land: LandGate;
  registration: Registration;
  decisionClass: string;
  reviewer: string;
  stored: MergeFacts;
}

/** Every fact is read afresh at `now`; any read that fails or disagrees with the gate skips it, so the gate stays the owner's. */
export async function readByRec(reads: ByRecReads, { runId, gate }: PendingGate, now: number): Promise<ByRecReadResult> {
  const known = knownFacts(reads, runId, gate);
  if ("skip" in known) return known;
  const pull = await reads.services.port.getPr(known.land.repo, known.land.pr);
  if (pull.state !== "open" || pull.merged || pull.headSha !== known.land.head) return { skip: "head-moved" };
  const fresh = await freshFacts(reads.services.port, known, pull);
  if ("skip" in fresh) return fresh;
  const holdClasses = holdClassesOf(known.registration, reads.services.store.get().parkedHold(runId));
  const merge: MergeFacts = { ...known.stored, ...fresh, repoFrozen: reads.services.freeze?.get().isFrozen(known.land.repo) ?? false, ownerGate: ownerGateOf(gate, known.land.head, now), holdClasses, headRef: pull.headRef };
  const unmet = unmetByRec(merge);
  return { subject: subjectOf(known, merge, holdClasses), merge, unmet, land: known.land, reviewer: known.reviewer };
}

function knownFacts(reads: ByRecReads, runId: string, gate: GateRecord): Known | { skip: string } {
  const land = landGate(gate);
  const run = reads.host.runtime.status(runId);
  if (!land || run?.workflowName !== SHEPHERD_WORKFLOW) return { skip: "not-a-shepherd-land-gate" };
  const rule = gatedRule(run, gate.prompt);
  const ruleId = rule && `${rule.table}/${rule.rowId}`;
  const decisionClass = rule && decisionClassOf({ table: rule.table, rowId: rule.rowId, step: "approve-merge", prompt: gate.prompt });
  if (!ruleId || !decisionClass || ELIGIBLE.get(ruleId) !== decisionClass) return { skip: `rule:${ruleId ?? "unrecorded"}` };
  const registration = reads.services.store.get().byRun(runId);
  if (!registration || registration.pr !== land.pr) return { skip: "unregistered" };
  const verdict = verdictAt(run, land.head);
  const stored = storedFacts(run, land.head);
  if (!verdict || !stored) return { skip: "no-merge-review-at-head" };
  return { gate, run, land, registration, decisionClass, reviewer: verdict.reviewer, stored };
}

/** The merge facts of the last evidence step at the head: who reviewed and which contexts and apps count. */
function storedFacts(run: WorkflowRun, head: string): MergeFacts | undefined {
  const step = `${MERGE_EVIDENCE_STEP}:${head}`;
  const results = Object.values(run.stepResults)
    .filter((result) => result.stepId === step || result.stepId.startsWith(`${step}:`))
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  const stored = MergeEvidenceSchema.safeParse(results.at(-1)?.data?.result);
  return stored.success && stored.data.head === head ? (stored.data.merge as MergeFacts) : undefined;
}

type Fresh = Pick<MergeFacts, "requiredContexts" | "checkRuns" | "mergeTreeClean" | "changedPaths">;

async function freshFacts(port: GitHubPort, { land }: Known, pull: PullRequest): Promise<Fresh | { skip: string }> {
  const [required, runs, paths] = await Promise.all([
    readRequiredChecks(port, land.repo, pull.baseRef),
    port.checkRuns(land.repo, land.head).then((all) => latestPerName(withoutEditRunSkips(all))),
    pinnedPaths(port, land, pull.headSha),
  ]);
  if (!required.readable) return { skip: "required-checks-unread" };
  if (paths.unread !== undefined) return { skip: "changed-files-unread" };
  const mergeTreeClean = pull.mergeSha !== null && mergeableOf(pull.mergeableState) === "MERGEABLE";
  return { requiredContexts: required.checks.contexts, checkRuns: runs.map(runFact), mergeTreeClean, changedPaths: paths.paths };
}

function runFact(run: CheckRun): CheckRunFact {
  return { name: run.name, appId: run.appId ?? -1, headSha: run.headSha, conclusion: run.conclusion };
}

function ownerGateOf(gate: GateRecord, head: string, now: number): OwnerGateFact {
  return { head, pending: gate.status === "pending", recommended: recommendedOption(gate) ?? null, openedAt: Date.parse(gate.createdAt), observedAt: now };
}

export function recommendedOption(gate: Pick<GateRecord, "questions">): string | undefined {
  return gate.questions?.flatMap((question) => question.options).find((option) => option.recommended === true)?.id;
}

/** Every hold on the run, by class; a hold whose reason names no class reads as `unclassified`, never as no hold. */
function holdClassesOf(registration: Registration, parked: { reason: string } | null): string[] {
  const top = registration.held && registration.ownerHold === null ? [holdClassOf(registration.holdReason) ?? "unclassified"] : [];
  const owner = registration.ownerHold === null ? [] : [OWNER_HOLD_CLASS];
  const under = parked === null ? [] : [holdClassOf(parked.reason) ?? "unclassified"];
  return [...top, ...owner, ...under];
}

/** MRG-AU-RB's unmet conditions; a table without that allow row meets none, so nothing merges. */
function unmetByRec(merge: MergeFacts): string[] {
  const row = DEFAULT_TABLE.rules.find((rule) => rule.id === BY_REC_RULE && rule.verdict === "allow");
  return row?.when ? unmetConditions(row.when, { merge }) : [`no ${BY_REC_RULE} allow row`];
}

function subjectOf({ gate, land, decisionClass, reviewer }: Known, merge: MergeFacts, holdClasses: string[]): ByRecSubject {
  const recommended = recommendedOption(gate);
  const rationale = `reviewer ${reviewer} said MERGE at ${land.head} and the required checks are green`;
  const ownerAtHead = ownerAtHeadRow(gate);
  return {
    ...{ source: "gate", id: gate.id, openedAt: gate.createdAt, summary: `Merge ${land.repo}#${land.pr} at ${land.head.slice(0, 12)}` },
    ...(recommended === MERGE_OPTION && { recommendation: { answer: MERGE_OPTION, by: reviewer, rationale } }),
    ...{ kind: "approve", door: (DOOR.exec(gate.prompt)?.[1] as "one-way" | "two-way" | undefined) ?? "two-way", decisionClass, holdClasses },
    ...{ authorityRows: [BY_REC_RULE], ownerAtHead: ownerAtHead === undefined ? [] : [ownerAtHead], paths: merge.changedPaths, headRef: merge.headRef },
    ...{ options: gate.questions?.flatMap((question) => question.options.map((option) => option.id)), closed: gate.status !== "pending" },
  };
}
