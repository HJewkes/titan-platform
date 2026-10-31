/**
 * The reads behind `shepherd brief` (TP-1696): the PR from the GitHubPort, and the run, its pending land gate and its
 * latest verdict with the reviewer's owner brief from Shepherd's own state. Reads only; the owner section is built from
 * these facts by `buildOwnerSection`.
 */
import type { GitHubPort, PrFile, PullRequest } from "@titan-design/github";
import { OwnerBriefSchema, type OwnerBrief } from "@titan-design/review-panel";
import { EXIT } from "@titan-design/registry";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { landGate } from "../coordinator-evidence.js";
import { checksAt } from "../coordinator-evidence-read.js";
import { stepIdMatches } from "../definition.js";
import type { FactoryHost } from "../host.js";
import { fixFirstAt, verdictAt } from "../verdict-at.js";
import { coded } from "./register-args.js";
import { runPolicyCeiling, type OwnerGateReason } from "./policy.js";
import type { ShepherdServices } from "./services.js";
import type { Registration } from "./store.js";
import { visualMatches } from "./visual-gate.js";

export interface BriefFacts {
  repo: string;
  pr: number;
  runId: string;
  /** `<initiative>/<ID>`, as the registration carries it. */
  task: string;
  url: string;
  title: string;
  /** The PR body; the renderer picks its Summary section. */
  body: string;
  head: string;
  base: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  ci: "green" | "red" | "pending";
  /** When Shepherd registered the PR, which stands in for its opening: the port's PR record carries no created date. */
  trackedSince: string;
  ui: boolean;
  ownerGateReason?: OwnerGateReason;
  /** The pending land approve-merge gate: the policy rule that opened it, the reason it gave, and the head it asks about. */
  gate: { rule: { table: string; rowId: string }; reason: string; head: string };
  /** The verdict at the PR head as Shepherd judges it, else the newest one at an older head. */
  verdict?: { verdict: "MERGE" | "FIX_FIRST"; head: string; reviewer: string; ownerBrief?: OwnerBrief };
}

const VerdictStep = z.looseObject({
  kind: z.literal("verdict"),
  verdict: z.enum(["MERGE", "FIX_FIRST"]),
  head: z.string(),
  reviewer: z.looseObject({ agentId: z.string() }),
  ownerBrief: OwnerBriefSchema.nullable().optional(),
});

type Verdict = NonNullable<BriefFacts["verdict"]>;

function verdictRecords(run: WorkflowRun): Array<Verdict & { stepId: string; completedAt: string }> {
  return Object.values(run.stepResults)
    .filter((result) => stepIdMatches("sh-await-verdict", result.stepId))
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
    .flatMap((step) => {
      const parsed = VerdictStep.safeParse((step.data as { result?: unknown } | undefined)?.result);
      if (!parsed.success) return [];
      const { verdict, head, reviewer, ownerBrief } = parsed.data;
      return [{ stepId: step.stepId, completedAt: step.completedAt, verdict, head, reviewer: reviewer.agentId, ...(ownerBrief && { ownerBrief }) }];
    });
}

const strip = ({ verdict, head, reviewer, ownerBrief }: Verdict): Verdict => ({ verdict, head, reviewer, ...(ownerBrief && { ownerBrief }) });

/**
 * The verdict the brief reports for the PR head, judged by Shepherd's own `fixFirstAt` and `verdictAt`, so the brief never
 * reads MERGE where the merge path would refuse: any FIX_FIRST at the head wins, MERGE needs every record there to agree,
 * and a head with neither falls back to the newest verdict at another head, which the section reports as a stale review.
 */
export function verdictForHead(run: WorkflowRun, prHead: string): BriefFacts["verdict"] {
  const records = verdictRecords(run);
  const atHead = records.filter((record) => record.head === prHead);
  if (fixFirstAt(run, prHead)) {
    const fixFirst = atHead.find((record) => record.verdict === "FIX_FIRST");
    return strip(fixFirst ?? { verdict: "FIX_FIRST", head: prHead, reviewer: "shepherd" });
  }
  const merge = verdictAt(run, prHead);
  if (merge) {
    const base = atHead.find((record) => record.stepId === merge.step);
    return strip(base ?? { verdict: "MERGE", head: prHead, reviewer: merge.reviewer });
  }
  const older = records.find((record) => record.head !== prHead);
  return older && strip(older);
}

/** Shepherd's own read of the base's required contexts at the head; unreadable required checks are never green. */
async function ciAtHead(port: GitHubPort, repo: string, base: string, head: string): Promise<BriefFacts["ci"]> {
  const { state } = await checksAt(port, repo, base, head);
  if (state === "failing") return "red";
  return state === "green" ? "green" : "pending";
}

function pendingLandGate(host: FactoryHost, run: WorkflowRun, repo: string, pr: number): NonNullable<ReturnType<typeof landGate>> {
  for (const { runId, gate } of host.pendingGates()) {
    const land = runId === run.id ? landGate(gate) : undefined;
    if (land && land.repo.toLowerCase() === repo.toLowerCase() && land.pr === pr) return land;
  }
  throw coded(`${repo}#${pr} has no pending approve-merge gate, so there is no owner question to brief`, EXIT.NOINPUT);
}

function requireRegistration(services: ShepherdServices, repo: string, pr: number): Registration {
  const found = services.store.get().byPr(repo, pr);
  if (!found) throw coded(`${repo}#${pr} is not registered with shepherd`, EXIT.NOINPUT);
  return found;
}

function requireRun(host: FactoryHost, registration: Registration): WorkflowRun {
  const run = host.runtime.status(registration.runId);
  if (!run) throw coded(`shepherd run ${registration.runId} is missing from the workflow store`, EXIT.SOFTWARE);
  return run;
}

const sum = (files: readonly PrFile[], key: "additions" | "deletions"): number => files.reduce((total, file) => total + (file[key] ?? 0), 0);

async function readPr(port: GitHubPort, repo: string, number: number): Promise<{ pr: PullRequest; files: PrFile[]; ci: BriefFacts["ci"] }> {
  const pr = await port.getPr(repo, number);
  const [files, ci] = await Promise.all([port.listPrFiles(repo, number), ciAtHead(port, repo, pr.baseRef, pr.headSha)]);
  return { pr, files, ci };
}

export async function readBriefFacts(host: FactoryHost, services: ShepherdServices, target: { repo: string; pr: number }): Promise<BriefFacts> {
  const registration = requireRegistration(services, target.repo, target.pr);
  const run = requireRun(host, registration);
  const land = pendingLandGate(host, run, target.repo, target.pr);
  const { pr, files, ci } = await readPr(services.port, target.repo, target.pr);
  const policy = runPolicyCeiling(run.params.policy);
  const verdict = verdictForHead(run, pr.headSha);
  const ui = policy.ownerGateReason === "gate-2-visual" || visualMatches(files.map((file) => file.path), policy.visualPaths ?? []).length > 0;
  const [table = "", rowId = ""] = land.rule.split("/");
  return {
    repo: target.repo,
    pr: target.pr,
    runId: run.id,
    task: registration.task,
    url: `https://github.com/${target.repo}/pull/${target.pr}`,
    title: pr.title ?? "",
    body: pr.body ?? "",
    head: pr.headSha,
    base: pr.baseRef,
    additions: sum(files, "additions"),
    deletions: sum(files, "deletions"),
    changedFiles: files.length,
    ci,
    trackedSince: registration.createdAt,
    ui,
    ...(policy.ownerGateReason && { ownerGateReason: policy.ownerGateReason }),
    gate: { rule: { table, rowId }, reason: land.reason, head: land.head },
    ...(verdict && { verdict }),
  };
}
