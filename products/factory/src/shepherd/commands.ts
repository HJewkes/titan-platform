import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import { EXIT, defineCommand, type AnyCommand } from "@titan-design/registry";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import type { GateDecision } from "../gate-policy.js";
import type { FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import type { FreezeStoreRef } from "./freeze.js";
import {
  RegistrationRefused,
  RequestedPolicyFields,
  resolveEffectivePolicy,
  runPolicyCeiling,
  shepherdGatePolicy,
  stricterPolicy,
  type EffectivePolicy,
} from "./policy.js";
import { HoldReasonSchema, type HoldResult } from "./hold-reason.js";
import { RELEASE_IMPLEMENTER, releaseTask } from "./release.js";
import { restartFor } from "./restart.js";
import { resyncShepherd, type ResyncReport } from "./resync.js";
import { FINISHED_RUN_STATUSES } from "./run-status.js";
import { isRepoKey, lookupSeat, type SeatBook } from "./seats.js";
import { TASK_KINDS, kindMoveRefusal, type Registration, type ShepherdStore, type ShepherdStoreRef } from "./store.js";
import type { MergeTrainRef } from "./train.js";
import type { SnapshotServices } from "./snapshot-reads.js";
import type { Phase } from "./step-phase.js";
import { waitingCommand } from "./waiting.js";
import { timelineEntries, watchRow, type PrTimeline, type WatchRow } from "./view.js";

export const SHEPHERD_WORKFLOW = "shepherd-pr";

/** What the shepherd commands read beyond the host; the route set that binds the store carries it. */
export interface ShepherdServices extends SnapshotServices {
  store: ShepherdStoreRef;
  port: GitHubPort;
  /** Read on every register, so a seat or deny change applies without a restart; an unreadable seat book refuses. */
  seats: () => SeatBook;
  /** Absent means no row reports a run waiting for its repo's merge train. */
  train?: MergeTrainRef;
  /** Read before a gate a freeze caused is superseded, and watched for thaws; absent means no repo is ever frozen. */
  freeze?: FreezeStoreRef;
}

export interface Registered {
  runId: string;
  /** False when `repo#pr`, or the PR's head branch, was already registered and its run came back instead. */
  created: boolean;
  registration: Registration;
  /** Set when a failed or restartable stopped run was replaced: the run this registration pointed at before. */
  previousRunId?: string;
  /** Why the replaced run stopped, when it completed rather than failed. */
  previousStop?: string;
}

export interface MergeEvaluation {
  runId: string;
  phase: Phase;
  /** What the run's policy says about a merge of its current head; nothing is resolved or signalled. */
  decision: GateDecision;
  held: { reason: string } | null;
  pendingGate: WatchRow["pendingGate"];
  waiting: string;
}

const coded = (message: string, code: number): Error => Object.assign(new Error(message), { code });

function servicesOf(ctx: FactoryContext): ShepherdServices {
  if (!ctx.shepherd) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
  return ctx.shepherd;
}

const RepoArg = z.string().refine(isRepoKey, "must be owner/repo");
const PrArg = z.number().int().positive();
/** Git's ref-name rules, loosely: no whitespace, control characters or the characters git reserves. */
const BranchArg = z.string().regex(/^[^\s~^:?*[\\\p{Cc}]+$/u, "must be a branch name");

const RegisterArgs = z
  .object({
    repo: RepoArg,
    pr: PrArg.optional(),
    branch: BranchArg.optional(),
    task: z.string().min(1),
    implementer: z.string().min(1),
    reviewer: z.string().min(1).optional(),
    kind: z.enum(TASK_KINDS).optional(),
    slice: z.string().min(1).optional(),
    noSlice: z.boolean().optional(),
    policy: RequestedPolicyFields.optional(),
  })
  .refine((args) => args.pr !== undefined || args.branch !== undefined, { message: "needs a pr or a branch", path: ["pr"] })
  .refine((args) => args.slice === undefined || !args.noSlice, { message: "slice and noSlice are exclusive", path: ["noSlice"] });

type RegisterArgs = z.infer<typeof RegisterArgs>;

/** A deny or unreadable seat book throws here, before anything is looked up or started. */
function policyFor(services: ShepherdServices, args: RegisterArgs): EffectivePolicy {
  try {
    return resolveEffectivePolicy(lookupSeat(services.seats(), args.repo), args.policy ?? {});
  } catch (error) {
    if (error instanceof RegistrationRefused) throw coded(`registration refused: ${error.message}`, EXIT.DATAERR);
    throw error;
  }
}

/** The registration of another PR that holds `branch` under a run that has finished, if any. */
function finishedBranchHolder(ctx: FactoryContext, store: ShepherdStore, repo: RepoSlug, pr: number | undefined, branch: string | undefined): Registration | undefined {
  const byBranch = branch === undefined ? undefined : store.byBranch(repo, branch);
  if (!byBranch || pr === undefined || byBranch.pr === null || byBranch.pr === pr) return undefined;
  return FINISHED_RUN_STATUSES.has(ctx.host.runtime.status(byBranch.runId)?.status ?? "completed") ? byBranch : undefined;
}

/**
 * The registration for `repo#pr`, else the one for its head branch. A branch tied to another PR is refused while that
 * PR's run is live; a finished run gives the branch up (see `releaseFinishedBranch`). Reads only.
 */
function findRegistration(ctx: FactoryContext, store: ShepherdStore, repo: RepoSlug, pr: number | undefined, branch: string | undefined): Registration | undefined {
  const byPr = pr === undefined ? undefined : store.byPr(repo, pr);
  if (byPr) return byPr;
  const byBranch = branch === undefined ? undefined : store.byBranch(repo, branch);
  if (!byBranch || pr === undefined || byBranch.pr === null || byBranch.pr === pr) return byBranch;
  if (finishedBranchHolder(ctx, store, repo, pr, branch)) return undefined;
  throw coded(`${repo} branch ${branch} is already shepherded as #${byBranch.pr} by run ${byBranch.runId}`, EXIT.DATAERR);
}

/** The changesets branch is reused by every release, so a finished run's hold on it is dropped once a lookup finds nothing. */
function releaseFinishedBranch(ctx: FactoryContext, store: ShepherdStore, repo: RepoSlug, pr: number | undefined, branch: string | undefined): void {
  const holder = finishedBranchHolder(ctx, store, repo, pr, branch);
  if (holder) store.releaseBranch(holder.runId);
}

/** A PR registration always learns its head branch, so a later branch registration finds it and vice versa. */
async function headBranch(services: ShepherdServices, args: RegisterArgs): Promise<string | undefined> {
  if (args.pr === undefined) return args.branch;
  const { headRef } = await services.port.getPr(args.repo, args.pr);
  if (args.branch !== undefined && args.branch !== headRef) throw coded(`${args.repo}#${args.pr} has head ${headRef}, not ${args.branch}`, EXIT.DATAERR);
  return headRef;
}

/** A repeat register without a slice keeps the stored one; only an explicit noSlice clears it. */
function sliceAfter(existing: Registration, args: RegisterArgs): string | undefined {
  if (args.noSlice) return undefined;
  return args.slice ?? existing.slice ?? undefined;
}

/** Checked before a failed run is replaced, so a refused kind leaves the run and its registration untouched. */
function refuseKindMove(existing: Registration, args: RegisterArgs): void {
  const refusal = args.kind === undefined ? undefined : kindMoveRefusal(existing.kind, args.kind);
  if (refusal) throw coded(`registration refused: run ${existing.runId}: ${refusal}`, EXIT.DATAERR);
}

function refresh(store: ShepherdStore, existing: Registration, args: RegisterArgs, policy: EffectivePolicy): Registered {
  const { runId } = existing;
  try {
    store.update(runId, { task: args.task, implementer: args.implementer, reviewer: args.reviewer, policy, kind: args.kind, slice: sliceAfter(existing, args) });
  } catch (error) {
    if (error instanceof RegistrationRefused) throw coded(`registration refused: ${error.message}`, EXIT.DATAERR);
    throw error;
  }
  if (args.pr !== undefined && existing.pr === null) store.setPr(runId, args.pr);
  return { runId, created: false, registration: store.byRun(runId)! };
}

/** `onStart` writes the registration in the transaction that inserts the run, so neither commits without the other. */
function startRun(ctx: FactoryContext, args: RegisterArgs, branch: string | undefined, policy: EffectivePolicy, onStart: (runId: string) => void): string {
  const target = { repo: args.repo, ...(args.pr !== undefined && { pr: String(args.pr) }), ...(branch !== undefined && { branch }) };
  return ctx.host.runtime.start(SHEPHERD_WORKFLOW, { ...target, policy: JSON.stringify(policy), task: args.task }, { onStart });
}

/** A dead run's registration moves to a new run, which starts at the pull request's current head; any other run comes back unchanged. */
async function reuseOrRestart(ctx: FactoryContext, store: ShepherdStore, known: Registration, args: RegisterArgs, policy: EffectivePolicy): Promise<Registered> {
  const restart = await restartFor(ctx.host, servicesOf(ctx), known);
  if (!restart) return refresh(store, known, args, policy);
  refuseKindMove(known, args);
  const previousRunId = known.runId;
  let runId: string;
  try {
    runId = startRun(ctx, args, known.branch ?? undefined, policy, (started) => store.repoint(previousRunId, started));
  } catch (error) {
    const winner = store.byRun(previousRunId) ? undefined : findRegistration(ctx, store, args.repo, args.pr, known.branch ?? undefined);
    if (!winner) {
      if (!store.byRun(previousRunId)) releaseFinishedBranch(ctx, store, args.repo, args.pr, known.branch ?? undefined);
      throw error;
    }
    return refresh(store, winner, args, policy);
  }
  return { ...refresh(store, store.byRun(runId)!, args, policy), created: true, previousRunId, ...restart };
}

/** Another process's register can commit between the lookup and the start; its unique row rolls this run back and its run comes back. */
async function startRegistered(ctx: FactoryContext, store: ShepherdStore, args: RegisterArgs, branch: string | undefined, policy: EffectivePolicy): Promise<Registered> {
  let registration: Registration | undefined;
  try {
    const runId = startRun(ctx, args, branch, policy, (started) => {
      registration = store.register({ ...args, branch, runId: started, policy });
    });
    return { runId, created: true, registration: registration! };
  } catch (error) {
    const winner = findRegistration(ctx, store, args.repo, args.pr, branch);
    if (!winner) {
      releaseFinishedBranch(ctx, store, args.repo, args.pr, branch);
      throw error;
    }
    return reuseOrRestart(ctx, store, winner, args, policy);
  }
}

async function register(args: RegisterArgs, ctx: FactoryContext): Promise<Registered> {
  const services = servicesOf(ctx);
  const policy = policyFor(services, args);
  const known = findRegistration(ctx, services.store.get(), args.repo, args.pr, args.branch);
  if (known) return reuseOrRestart(ctx, services.store.get(), known, args, policy);
  releaseFinishedBranch(ctx, services.store.get(), args.repo, args.pr, args.branch);
  const branch = await headBranch(services, args);
  const store = services.store.get();
  const existing = findRegistration(ctx, store, args.repo, args.pr, branch);
  if (existing) return reuseOrRestart(ctx, store, existing, args, policy);
  releaseFinishedBranch(ctx, store, args.repo, args.pr, branch);
  return startRegistered(ctx, store, args, branch, policy);
}

/** Registers the changesets PR the way `shepherd register` would, with no fixer: no agent wrote it, so none can fix it. */
export async function registerVersionPackages(ctx: FactoryContext, repo: RepoSlug, pr: number): Promise<Registered> {
  return register({ repo, pr, task: releaseTask(repo), implementer: RELEASE_IMPLEMENTER, policy: { fixer: false } }, ctx);
}

/** `repo#pr` directly, or through its head branch when a branch registration has not seen the PR yet. */
async function locate(services: ShepherdServices, repo: RepoSlug, pr: number): Promise<Registration> {
  const direct = services.store.get().byPr(repo, pr);
  if (direct) return direct;
  const { headRef } = await services.port.getPr(repo, pr);
  const viaBranch = services.store.get().byBranch(repo, headRef);
  if (viaBranch && (viaBranch.pr === null || viaBranch.pr === pr)) return viaBranch;
  throw coded(`${repo}#${pr} is not registered with shepherd`, EXIT.NOINPUT);
}

function runOf(host: FactoryHost, registration: Registration): WorkflowRun {
  const run = host.runtime.status(registration.runId);
  if (!run) throw coded(`shepherd run ${registration.runId} is missing from the workflow store`, EXIT.SOFTWARE);
  return run;
}

function rowOf(host: FactoryHost, services: ShepherdServices, registration: Registration, run: WorkflowRun): WatchRow {
  const pending = host.pendingGates().find((gate) => gate.runId === run.id);
  const train = services.train?.get().holder(registration.repo);
  return watchRow({ registration, run, ...(pending && { pending: { gate: pending.gate, stepId: pending.stepId } }), ...(train && { train }) });
}

function rows(host: FactoryHost, services: ShepherdServices): WatchRow[] {
  return services.store
    .get()
    .all()
    .flatMap((registration) => {
      const run = host.runtime.status(registration.runId);
      return run ? [rowOf(host, services, registration, run)] : [];
    });
}

/** Every gate the run opened: the ones its results name, and the one it waits on now. */
function gatesOf(host: FactoryHost, run: WorkflowRun): GateRecord[] {
  const ids = new Set(Object.keys(run.stepResults).map((key) => `${run.id}/${key}`));
  for (const gate of host.gates.listPending()) if (gate.id.startsWith(`${run.id}/`)) ids.add(gate.id);
  return [...ids].flatMap((id) => host.gates.get(id) ?? []);
}

function runPolicy(run: WorkflowRun): EffectivePolicy {
  return runPolicyCeiling(run.params.policy);
}

/** Reports what the run would decide and why it waits; it never signals the run or resolves a gate. */
async function evaluateMerge({ repo, pr }: PrRefArgs, ctx: FactoryContext): Promise<MergeEvaluation> {
  const services = servicesOf(ctx);
  const registration = await locate(services, repo, pr);
  const run = runOf(ctx.host, registration);
  const row = rowOf(ctx.host, services, registration, run);
  const policy = stricterPolicy(registration.policy, runPolicy(run));
  const decision = shepherdGatePolicy(policy).decide("merge", row.headSha === null ? undefined : { headSha: row.headSha });
  const held = services.store.get().heldReason(repo, pr, registration.branch ?? undefined, row.headSha ?? undefined);
  return { runId: run.id, phase: row.phase, decision, held: held === undefined ? null : { reason: held }, pendingGate: row.pendingGate, waiting: row.nextAction };
}

const PrRefArgs = z.object({ repo: RepoArg, pr: PrArg });
type PrRefArgs = z.infer<typeof PrRefArgs>;

const LIST_STATES = ["active", "finished", "all"] as const;
const FINISHED: ReadonlySet<Phase> = new Set(["done", "failed", "cancelled"]);

const registerCommand = defineCommand<RegisterArgs, Registered, FactoryContext>({
  name: "shepherd.register",
  description: "Shepherd owner/repo#pr, or a branch whose PR is not open yet; a repeat registration returns the existing run, or starts a new one when that run failed or stopped not-mergeable or on a conflict with its PR still open",
  args: RegisterArgs,
  result: z.custom<Registered>(),
  run: register,
});

const statusCommand = defineCommand<{ repo?: string; pr?: number }, WatchRow[], FactoryContext>({
  name: "shepherd.status",
  description: "One row per shepherded PR, optionally narrowed to a repo or a PR: phase, head, next action and blockers",
  args: z.object({ repo: RepoArg.optional(), pr: PrArg.optional() }),
  result: z.custom<WatchRow[]>(),
  run: async ({ repo, pr }, ctx) =>
    rows(ctx.host, servicesOf(ctx)).filter((row) => (repo === undefined || row.repo === repo.toLowerCase()) && (pr === undefined || row.pr === pr)),
});

const waiting = waitingCommand((ctx) => rows(ctx.host, servicesOf(ctx)));

const listCommand = defineCommand<{ state: (typeof LIST_STATES)[number] }, WatchRow[], FactoryContext>({
  name: "shepherd.list",
  description: "The watch list: every shepherded PR whose run is active (default), finished, or all of them",
  args: z.object({ state: z.enum(LIST_STATES).default("active") }),
  result: z.custom<WatchRow[]>(),
  run: async ({ state }, ctx) =>
    rows(ctx.host, servicesOf(ctx)).filter((row) => state === "all" || FINISHED.has(row.phase) === (state === "finished")),
});

const timelineCommand = defineCommand<PrRefArgs, PrTimeline, FactoryContext>({
  name: "shepherd.timeline",
  description: "The watch row for owner/repo#pr and every step result, gate, hold, release, freeze and thaw its run recorded, oldest first",
  args: PrRefArgs,
  result: z.custom<PrTimeline>(),
  async run({ repo, pr }, ctx) {
    const services = servicesOf(ctx);
    const registration = await locate(services, repo, pr);
    const run = runOf(ctx.host, registration);
    return { row: rowOf(ctx.host, services, registration, run), entries: timelineEntries(run, gatesOf(ctx.host, run), services.store.get().eventsOf(registration.runId)) };
  },
});

const HoldArgs = PrRefArgs.extend({ reason: HoldReasonSchema, reviewer: z.string().regex(/^\S+$/, "must be a non-empty name without whitespace").optional() });

const holdCommand = defineCommand<z.infer<typeof HoldArgs>, HoldResult, FactoryContext>({
  name: "shepherd.hold",
  description: "Hold owner/repo#pr: its run keeps going, but no merge goes through until release; --reviewer names the reviewer whose verdict the run waits for",
  args: HoldArgs,
  result: z.custom<HoldResult>(),
  async run({ repo, pr, reason, reviewer }, ctx) {
    const services = servicesOf(ctx);
    const { runId } = await locate(services, repo, pr);
    const held = services.store.get().hold(runId, reason, reviewer);
    return { runId, held: { reason: held.holdReason ?? reason, ...(held.holdReviewer !== null && { reviewer: held.holdReviewer }) } };
  },
});

const releaseCommand = defineCommand<PrRefArgs, HoldResult, FactoryContext>({
  name: "shepherd.release",
  description: "Release a hold on owner/repo#pr so a merge its run reaches can go through",
  args: PrRefArgs,
  result: z.custom<HoldResult>(),
  async run({ repo, pr }, ctx) {
    const services = servicesOf(ctx);
    const { runId } = await locate(services, repo, pr);
    services.store.get().release(runId);
    return { runId, held: null };
  },
});

const mergeCommand = defineCommand<PrRefArgs, MergeEvaluation, FactoryContext>({
  name: "shepherd.merge",
  description: "Evaluate the merge of owner/repo#pr now: the policy decision and what the run waits on. Resolves nothing",
  args: PrRefArgs,
  result: z.custom<MergeEvaluation>(),
  run: evaluateMerge,
});

const resyncCommand = defineCommand<{ dryRun?: boolean }, ResyncReport, FactoryContext>({
  name: "shepherd.resync",
  description: "End runs whose PR was merged or closed outside Shepherd, cancel the gates of runs that already ended, and supersede gates whose PR moved head; dryRun only reports",
  args: z.object({ dryRun: z.boolean().optional() }),
  result: z.custom<ResyncReport>(),
  run: async ({ dryRun }, ctx) => resyncShepherd(ctx.host, servicesOf(ctx), { dryRun }),
});

/** Keyed by name so a consumer can type itself per verb; each key must equal its command's `name`. */
export const SHEPHERD_COMMAND_MAP = {
  "shepherd.register": registerCommand,
  "shepherd.status": statusCommand,
  "shepherd.list": listCommand,
  "shepherd.waiting": waiting,
  "shepherd.timeline": timelineCommand,
  "shepherd.hold": holdCommand,
  "shepherd.release": releaseCommand,
  "shepherd.merge": mergeCommand,
  "shepherd.resync": resyncCommand,
};

export type ShepherdCommandName = keyof typeof SHEPHERD_COMMAND_MAP;

/** Gate resolution is deliberately absent: it stays the local `titan-factory gate resolve`, never a network call. */
export const SHEPHERD_COMMANDS: readonly AnyCommand<FactoryContext>[] = Object.values(SHEPHERD_COMMAND_MAP);
