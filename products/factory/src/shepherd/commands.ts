import type { RepoSlug } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import { EXIT, defineCommand, type AnyCommand } from "@titan-design/registry";
import type { WorkflowRun, WorkflowStatus } from "@titan-design/workflow";
import { z } from "zod";
import type { GateDecision } from "../gate-policy.js";
import type { FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { RegistrationRefused, runPolicyCeiling, shepherdGatePolicy, stricterPolicy, type EffectivePolicy } from "./policy.js";
import { HoldReasonSchema, OWNER_HOLD_CLASS, ReleasableClassSchema, type HoldResult } from "./hold-reason.js";
import { isOwnerHold } from "./owner-hold-rows.js";
import { refuseUnknownGates } from "./lan-gates.js";
import { RELEASE_IMPLEMENTER, releaseTask } from "./release.js";
import { ownUpdatedHeads } from "./merge-up-release.js";
import { ReleaseHeadArg, releaseAtHead, updateBranchRunning } from "./release-head.js";
import { cachedByHead, localPrFiles } from "./git-pr-files.js";
import { applyRegistrationHold } from "./registration-hold.js";
import { briefCommand } from "./brief-command.js";
import { prsCommand } from "./prs-command.js";
import { kindMove, testOnlyHint, type KindMove } from "./register-kind.js";
import { PrArg, RegisterArgs, RepoArg, coded, headBranch, policyFor, refuseKindMove, sliceAfter } from "./register-args.js";
import { endSuperseded, isDivergedEnd, isReplayDiverged, restartFor } from "./restart.js";
import { lastReadHead } from "./last-read-head.js";
import { sizeFlagFor, type SliceFlag } from "./size-flag.js";
import { resyncShepherd, type ResyncReport } from "./resync.js";
import { orderCommand, type StatusOrder } from "./merge-order-command.js";
import { repairStopCommand } from "./repair-stop-command.js";
import { mergeBaseCommand } from "./merge-base-command.js";
import { repoFreezeCommand } from "./repo-freeze-command.js";
import { reviewCommand } from "./review-request.js";
import { thawCommand } from "./thaw-command.js";
import { fixPrCommand } from "./fix-pr-command.js";
import { findRegistration, releaseFinishedBranch } from "./registration-lookup.js";
import type { Registration, ShepherdStore } from "./store.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./services.js";
import type { Phase } from "./step-phase.js";
import { carry, type CarryInput } from "./tree-carry.js";
import { waitingCommand } from "./waiting.js";
import { visualDeltaCommand } from "./visual-delta-command.js";
import { watchCommand } from "./watch-command.js";
import { timelineEntries, type PrTimeline, type WatchRow } from "./view.js";
import { LIST_FILTER, mapRows, rowOf, runFinished, waitingFilter, watchRows, withOrder } from "./watch-rows.js";
import { stackFrozen } from "./stack-cascade.js";

/** Transitional, for workflows.ts until TP-2466 b repoints it. */
export type { ShepherdServices } from "./services.js";

export interface Registered {
  runId: string;
  /** False when `repo#pr`, or the PR's head branch, was already registered and its run came back instead. */
  created: boolean;
  registration: Registration;
  /** Set when a failed, replay-diverged or restartable stopped run was replaced: the run this registration pointed at before. */
  previousRunId?: string;
  /** Why the replaced run stopped, when it completed rather than failed. */
  previousStop?: string;
  /** The G10 hold Shepherd placed at this registration, when the PR's class needs one. */
  g10Hold?: string;
  /** Set when a security-kind or guard-area PR is over the 400 non-generated line slice cap; advisory, never a hold. */
  sizeFlag?: SliceFlag;
  /** Set when a correctness registration is on a PR that changes only tests, once the guard accepts test-only. */
  kindHint?: string;
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

const DEFAULT_KIND = "correctness";

function servicesOf(ctx: FactoryContext): ShepherdServices {
  if (!ctx.shepherd) throw coded("shepherd commands need the shepherd routes, and this host was opened without them", EXIT.UNAVAILABLE);
  return ctx.shepherd;
}

function refresh(store: ShepherdStore, existing: Registration, args: RegisterArgs, policy: EffectivePolicy, move: KindMove): Registered {
  const { runId } = existing;
  const { task, implementer, registrant, reviewer, kind, head: headSha, base } = args;
  const meta = { task, implementer, registrant, reviewer, policy, kind, slice: sliceAfter(existing, args), headSha, base, lastSlice: args.lastSlice };
  try {
    store.update(runId, { ...meta, ...move });
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
export async function restartRegistered(ctx: FactoryContext, store: ShepherdStore, known: Registration, args: RegisterArgs, policy: EffectivePolicy): Promise<Registered> {
  const move = await kindMove(servicesOf(ctx), known, args);
  const restart = await restartFor(ctx.host, servicesOf(ctx), known);
  if (!restart) return refresh(store, known, args, policy, move);
  refuseKindMove(known, args, move);
  const previousRunId = known.runId;
  const previousRun = ctx.host.runtime.status(previousRunId)!;
  const seeded = isDivergedEnd(previousRun) ? { ...args, head: args.head ?? lastReadHead(previousRun) } : args;
  let runId: string;
  try {
    runId = startRun(ctx, args, known.branch ?? undefined, policy, (started) => store.repoint(previousRunId, started));
  } catch (error) {
    const winner = store.byRun(previousRunId) ? undefined : findRegistration(ctx, store, args.repo, args.pr, known.branch ?? undefined);
    if (!winner) {
      if (!store.byRun(previousRunId)) releaseFinishedBranch(ctx, store, args.repo, args.pr, known.branch ?? undefined);
      throw error;
    }
    return refresh(store, winner, args, policy, move);
  }
  if (isReplayDiverged(previousRun)) endSuperseded(ctx.host, previousRunId, runId);
  return { ...refresh(store, store.byRun(runId)!, seeded, policy, move), created: true, previousRunId, ...restart };
}

/**
 * Another process's register can commit between the lookup and the start; its unique row rolls this run back and its run comes back.
 * A new run with no kind stores correctness here, never in the CLI, so a kindless repeat keeps whatever kind the run already has.
 */
async function startRegistered(ctx: FactoryContext, store: ShepherdStore, args: RegisterArgs, branch: string | undefined, policy: EffectivePolicy): Promise<Registered> {
  let registration: Registration | undefined;
  try {
    const runId = startRun(ctx, args, branch, policy, (started) => {
      registration = store.register({ ...args, kind: args.kind ?? DEFAULT_KIND, branch, runId: started, policy, headSha: args.head });
    });
    return { runId, created: true, registration: registration! };
  } catch (error) {
    const winner = findRegistration(ctx, store, args.repo, args.pr, branch);
    if (!winner) {
      releaseFinishedBranch(ctx, store, args.repo, args.pr, branch);
      throw error;
    }
    return restartRegistered(ctx, store, winner, args, policy);
  }
}

async function register(args: RegisterArgs, ctx: FactoryContext): Promise<Registered> {
  const services = servicesOf(ctx);
  const policy = policyFor(services.seats, args);
  const known = findRegistration(ctx, services.store.get(), args.repo, args.pr, args.branch);
  if (known) return restartRegistered(ctx, services.store.get(), known, args, policy);
  releaseFinishedBranch(ctx, services.store.get(), args.repo, args.pr, args.branch);
  const branch = await headBranch(services.port, args);
  const store = services.store.get();
  const existing = findRegistration(ctx, store, args.repo, args.pr, branch);
  if (existing) return restartRegistered(ctx, store, existing, args, policy);
  releaseFinishedBranch(ctx, store, args.repo, args.pr, branch);
  return startRegistered(ctx, store, args, branch, policy);
}

/**
 * Only a seat's registration is classed: the release and toolchain PRs Shepherd registers itself carry no seat to release a hold.
 * A repeat registration is classed again, so a diff that grew past the size limit or into a stronger class gets its hold.
 * The hold and the slice-cap flag share one git read of the head's files.
 */
async function registerWithHold(args: RegisterArgs, ctx: FactoryContext): Promise<Registered> {
  const registered = await classifyRegistered(ctx, await register(args, ctx));
  const kindHint = await testOnlyHint(servicesOf(ctx), registered.registration);
  return kindHint === undefined ? registered : { ...registered, kindHint };
}

/** Holds and flags a registration for the diff it has now; a run Shepherd restarts is classed the way a live register would class it. */
export async function classifyRegistered(ctx: FactoryContext, registered: Registered, head?: string): Promise<Registered> {
  const services = servicesOf(ctx);
  const local = cachedByHead(services.prFiles ?? localPrFiles);
  const g10Hold = await applyRegistrationHold(services.port, services.store.get(), registered.runId, { local, ...(head !== undefined && { head }) });
  const held = g10Hold === undefined ? registered : { ...registered, g10Hold, registration: services.store.get().byRun(registered.runId)! };
  const sizeFlag = await sizeFlagFor(services.port, head === undefined ? held.registration : { ...held.registration, headSha: head }, { local });
  return sizeFlag === undefined ? held : { ...held, sizeFlag };
}

/** Registers the changesets PR the way `shepherd register` would, with no fixer: no agent wrote it, so none can fix it. */
export async function registerVersionPackages(ctx: FactoryContext, repo: RepoSlug, pr: number): Promise<Registered> {
  return register({ repo, pr, task: releaseTask(repo), implementer: RELEASE_IMPLEMENTER, kind: "unknown", policy: { fixer: false } }, ctx);
}

/** The registration's implementer: the factory toolchain sweep wrote this PR, so a wake for it is never handled. */
export const TOOLCHAIN_IMPLEMENTER = "toolchain-fanout";

function toolchainTask(repo: RepoSlug): string {
  return `${repo.split("/")[1] ?? repo}/toolchain`;
}

/** Registers a toolchain adoption PR with no fixer, since no agent can fix a plan the sweep wrote, and owner-gated, since it edits other repos' release workflows. */
export async function registerToolchainAdoption(ctx: FactoryContext, repo: RepoSlug, pr: number): Promise<Registered> {
  return register({ repo, pr, task: toolchainTask(repo), implementer: TOOLCHAIN_IMPLEMENTER, kind: "unknown", policy: { fixer: false, merge: "owner-gate", ownerGateReason: "owner-asked" } }, ctx);
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

const LIST_STATES = ["active", "finished", "all"] as const;

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

/** The seat or owner behind a hold or release, sent by the CLI because serve cannot read the caller's environment; a client that sends none is recorded as unknown. */
const ActorArg = z.string().min(1).max(100).default("unknown");
type PrRefArgs = z.infer<typeof PrRefArgs>;

const registerCommand = defineCommand<RegisterArgs, Registered, FactoryContext>({
  name: "shepherd.register",
  description: "Shepherd owner/repo#pr, or a branch whose PR is not open yet; a repeat registration returns the existing run, or starts a new one when that run failed, was cancelled, or stopped not-mergeable, on a conflict or abandoned, with its PR still open",
  args: RegisterArgs,
  result: z.custom<Registered>(),
  run: registerWithHold,
});

/** `stackFrozen` is read by agent-chat, which stacks no new child on a parent past its fix-round limit. */
export type StatusRow = WatchRow & StatusOrder & { stackFrozen: boolean };

interface StatusArgs {
  repo?: string;
  pr?: number;
  all?: boolean;
}

/**
 * Finished runs are dropped before any is loaded unless `all` is set or one PR is named: parsing every finished run's
 * step results on each call ran serve out of heap (TP-3517), while one PR's runs are few and `shepherd wait` reads its end.
 */
function statusFilter({ repo, pr, all }: StatusArgs): (registration: Registration, status: WorkflowStatus) => boolean {
  const wantsFinished = all === true || pr !== undefined;
  return (registration, status) =>
    (wantsFinished || !runFinished(status)) && (repo === undefined || registration.repo === repo.toLowerCase()) && (pr === undefined || registration.pr === pr);
}

const statusCommand = defineCommand<StatusArgs, StatusRow[], FactoryContext>({
  name: "shepherd.status",
  description: "One row per shepherded PR whose run has not finished, optionally narrowed to a repo or a PR (which lists its finished runs too): phase, head, next action, blockers, and whether new stacking on it is frozen; all lists every finished run as well",
  args: z.object({ repo: RepoArg.optional(), pr: PrArg.optional(), all: z.boolean().optional() }),
  result: z.custom<StatusRow[]>(),
  run: (args, ctx) => mapRows(ctx.host, servicesOf(ctx), statusFilter(args), ({ row, run }) => ({ ...withOrder(ctx.host, servicesOf(ctx), row), stackFrozen: stackFrozen(run) })),
});

const waiting = waitingCommand((ctx) => watchRows(ctx.host, servicesOf(ctx), waitingFilter(ctx.host)));

const listCommand = defineCommand<{ state: (typeof LIST_STATES)[number] }, WatchRow[], FactoryContext>({
  name: "shepherd.list",
  description: "The watch list: every shepherded PR whose run is active (default), finished, or all of them",
  args: z.object({ state: z.enum(LIST_STATES).default("active") }),
  result: z.custom<WatchRow[]>(),
  run: async ({ state }, ctx) => watchRows(ctx.host, servicesOf(ctx), LIST_FILTER[state]),
});

const timelineCommand = defineCommand<PrRefArgs, PrTimeline & { row: StatusOrder }, FactoryContext>({
  name: "shepherd.timeline",
  description: "The watch row for owner/repo#pr and every step result, gate, hold, release, freeze and thaw its run recorded, oldest first",
  args: PrRefArgs,
  result: z.custom<PrTimeline & { row: StatusOrder }>(),
  async run({ repo, pr }, ctx) {
    const services = servicesOf(ctx);
    const registration = await locate(services, repo, pr);
    const run = runOf(ctx.host, registration);
    const row = withOrder(ctx.host, services, rowOf(ctx.host, services, registration, run));
    return { row, entries: timelineEntries(run, gatesOf(ctx.host, run), services.store.get().eventsOf(registration.runId)) };
  },
});

/** A reviewer's MERGE must never pass an owner-asked hold, so one that names a reviewer is an argument error, exit 65. */
const HoldArgs = PrRefArgs.extend({ reason: HoldReasonSchema, reviewer: z.string().regex(/^\S+$/, "must be a non-empty name without whitespace").optional(), actor: ActorArg }).superRefine(({ reason, reviewer }, ctx) => {
  if (reviewer !== undefined && isOwnerHold(reason)) ctx.addIssue({ code: "custom", path: ["reviewer"], message: `hold refused, nothing was held: an ${OWNER_HOLD_CLASS} hold waits for the owner alone, so it takes no --reviewer` });
});

const holdCommand = defineCommand<z.infer<typeof HoldArgs>, HoldResult, FactoryContext>({
  name: "shepherd.hold",
  description: "Hold owner/repo#pr: its run keeps going, but no merge goes through until release; --reviewer names the reviewer whose verdict the run waits for",
  args: HoldArgs,
  result: z.custom<HoldResult>(),
  async run({ repo, pr, reason, reviewer, actor }, ctx) {
    const services = servicesOf(ctx);
    refuseUnknownGates(services.store.get().gateEvidence(), reason);
    const { runId } = await locate(services, repo, pr);
    const held = services.store.get().hold(runId, reason, reviewer, { actor });
    return { runId, held: { reason: held.holdReason ?? reason, ...(held.holdReviewer !== null && { reviewer: held.holdReviewer }) } };
  },
});

/** An owner-asked hold is not a class `release` can name: only the owner's own release lifts it. */
const ReleaseArgs = PrRefArgs.extend({ actor: ActorArg, head: ReleaseHeadArg, holdClass: ReleasableClassSchema.optional() });

const releaseCommand = defineCommand<z.infer<typeof ReleaseArgs>, HoldResult, FactoryContext>({
  name: "shepherd.release",
  description: "Release one hold on owner/repo#pr at the head the seat reviewed (--head): the hold of --class, or the only hold; refused when the PR's head is another sha, unless a g10-review or g10-adversary release and that head is Shepherd's own clean merge-up of it",
  args: ReleaseArgs,
  result: z.custom<HoldResult>(),
  async run({ repo, pr, head, actor, holdClass }, ctx) {
    const services = servicesOf(ctx);
    const registration = await locate(services, repo, pr);
    const { runId } = registration;
    const run = () => runOf(ctx.host, registration);
    const reads = { ownUpdates: () => ownUpdatedHeads(run()), updating: () => updateBranchRunning(run()), carry: (input: CarryInput) => carry(input) };
    const after = await releaseAtHead(services.store.get(), services.port, { runId, repo, pr, head, actor, ...(holdClass && { holdClass }) }, reads);
    return { runId, held: after.held ? { reason: after.holdReason ?? "held", ...(after.holdReviewer !== null && { reviewer: after.holdReviewer }) } : null };
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
  "shepherd.repair-stop": repairStopCommand,
  "shepherd.freeze": repoFreezeCommand,
  "shepherd.thaw": thawCommand,
  "shepherd.order": orderCommand,
  "shepherd.fix-pr": fixPrCommand,
  "shepherd.merge-base": mergeBaseCommand,
  "shepherd.merge": mergeCommand,
  "shepherd.review": reviewCommand,
  "shepherd.resync": resyncCommand,
  "shepherd.prs": prsCommand,
  "shepherd.watch": watchCommand,
  "shepherd.visual-delta": visualDeltaCommand,
  "shepherd.brief": briefCommand,
};

export type ShepherdCommandName = keyof typeof SHEPHERD_COMMAND_MAP;

/** Gate resolution is deliberately absent: it stays the local `titan-factory gate resolve`, never a network call. */
export const SHEPHERD_COMMANDS: readonly AnyCommand<FactoryContext>[] = Object.values(SHEPHERD_COMMAND_MAP);
