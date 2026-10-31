/**
 * The reads behind `shepherd brief` (TP-1696): the PR from the GitHubPort, and the run, its pending land gate and its
 * latest verdict with the reviewer's owner brief from Shepherd's own state. Reads only; the owner section is built from
 * these facts by `buildOwnerSection`.
 */
import type { CheckRun, GitHubPort, PrFile, PullRequest } from "@titan-design/github";
import { OwnerBriefSchema, type OwnerBrief } from "@titan-design/review-panel";
import { EXIT } from "@titan-design/registry";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { landGate } from "../coordinator-evidence.js";
import { stepIdMatches } from "../definition.js";
import type { FactoryHost } from "../host.js";
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
  /** The newest verdict the run recorded, at whatever head it read. */
  verdict?: { verdict: "MERGE" | "FIX_FIRST"; head: string; reviewer: string; ownerBrief?: OwnerBrief };
}

const VerdictStep = z.looseObject({
  kind: z.literal("verdict"),
  verdict: z.enum(["MERGE", "FIX_FIRST"]),
  head: z.string(),
  reviewer: z.looseObject({ agentId: z.string() }),
  ownerBrief: OwnerBriefSchema.nullable().optional(),
});

/** The newest `sh-await-verdict` step result that recorded a verdict; a wait that ended in `none` records none. */
export function latestVerdict(run: WorkflowRun): BriefFacts["verdict"] {
  const steps = Object.values(run.stepResults)
    .filter((result) => stepIdMatches("sh-await-verdict", result.stepId))
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  for (const step of steps) {
    const parsed = VerdictStep.safeParse((step.data as { result?: unknown } | undefined)?.result);
    if (parsed.success) {
      const { verdict, head, reviewer, ownerBrief } = parsed.data;
      return { verdict, head, reviewer: reviewer.agentId, ...(ownerBrief && { ownerBrief }) };
    }
  }
  return undefined;
}

const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);

/** Red on any failed check at the head, green only when every check there has completed. */
export function ciState(runs: readonly CheckRun[]): BriefFacts["ci"] {
  if (runs.some((run) => run.status === "completed" && run.conclusion !== null && FAILED.has(run.conclusion))) return "red";
  return runs.length > 0 && runs.every((run) => run.status === "completed") ? "green" : "pending";
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
  const [files, runs] = await Promise.all([port.listPrFiles(repo, number), port.latestCheckRuns(repo, pr.headSha)]);
  return { pr, files, ci: ciState(runs) };
}

export async function readBriefFacts(host: FactoryHost, services: ShepherdServices, target: { repo: string; pr: number }): Promise<BriefFacts> {
  const registration = requireRegistration(services, target.repo, target.pr);
  const run = requireRun(host, registration);
  const land = pendingLandGate(host, run, target.repo, target.pr);
  const { pr, files, ci } = await readPr(services.port, target.repo, target.pr);
  const policy = runPolicyCeiling(run.params.policy);
  const verdict = latestVerdict(run);
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
