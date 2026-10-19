import type { PullRequest, RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { CHECKS_RECHECK_MS, greenAtHead } from "../workflows/await-head.js";
import { codeRoute, step } from "../workflows/land.js";
import type { LandPrState } from "../workflows/land-pr.js";
import { headWasRerun, rerunFlakyHead } from "./flake-check.js";
import { holdClassOf } from "./g10-release.js";
import { noticeHeldSeat } from "./gate-route.js";
import type { GateRun } from "./gates.js";
import type { ShepherdDeps, WakeRequest } from "./phases.js";
import { PUSH_WATCH_TICK_MS, headPoll, leftHead } from "./push-signal.js";
import { stopCovering, type RepairStop } from "./repair-stop.js";
import type { Registration, ShepherdStore } from "./store.js";

const HELD_CHECK_STEP = "sh-held-check";
const HELD_WAIT_STEP = "sh-held-wait";
export const HELD_REPAIR_STEPS: readonly StepDeclaration[] = [
  { id: HELD_CHECK_STEP, kind: "dispatch" },
  { id: HELD_WAIT_STEP, kind: "dispatch" },
];
/** `repairs` and `stop` are recorded with the check, so a replay takes the path the live wake took whatever the store reads now. */
const HeldCheckResult = z.looseObject({ held: z.boolean(), reason: z.string().optional(), seat: z.string().optional(), repairs: z.boolean().optional(), stop: z.string().optional() });
const HeldWaitResult = z.looseObject({ moved: z.boolean(), headSha: z.string().optional(), green: z.boolean().optional() });
const RedPayload = z.looseObject({ failing: z.array(z.looseObject({ name: z.string(), conclusion: z.string().nullish() })) });
const VerdictPayload = z.looseObject({ kind: z.string() });

interface HeldInput {
  runId: string;
  repo: RepoSlug;
  pr: number;
  headSha: string;
}

interface HeldWaitInput extends HeldInput {
  reason: string;
  /** Set after a ci-red wake: every required check passing at the held head, as after a rerun, also ends the wait. */
  untilGreen?: boolean;
  /** The repair stop's scope when a stop, not a hold, keeps the wait: clearing it ends the wait, whatever the hold reads. */
  stop?: string;
}

/** A joined seat or `none` names no one agent to message, so the hub seat stands in. */
export const singleSeat = (seat: string | undefined): string | undefined => (seat === undefined || seat === "none" || seat.includes("+") ? undefined : seat);

function heldCheck(registration: Registration | undefined): z.infer<typeof HeldCheckResult> {
  if (!registration?.held) return { held: false };
  const seat = singleSeat(registration.policy.seat);
  return { held: true, reason: registration.holdReason ?? "held", ...(seat && { seat }) };
}

/** Decision 423(1): these classes gate the merge only. A named reviewer, an owner hold or a hold parked under one keeps the wait. */
const MERGE_ONLY_CLASSES: ReadonlySet<string | undefined> = new Set(["g10-review", "g10-adversary"]);

function repairsWhileHeld(store: ShepherdStore, registration: Registration): boolean {
  return MERGE_ONLY_CLASSES.has(holdClassOf(registration.holdReason)) && !registration.holdReviewer && registration.ownerHold === null && store.parkedHold(registration.runId) === null;
}

/** A seat's repair stop wins over every hold class and over `heldRepair`, so no fixer is woken or resumed while it stands. */
async function checkHold(deps: ShepherdDeps, input: HeldInput): Promise<z.infer<typeof HeldCheckResult>> {
  const store = deps.store.get();
  const registration = store.byRun(input.runId);
  const stop = await stopCovering(deps.port, store.repairStops().list(input.repo), input);
  if (stop) return stoppedCheck(stop, registration);
  const hold = heldCheck(registration);
  return hold.held && deps.heldRepair === "on" && registration && repairsWhileHeld(store, registration) ? { ...hold, repairs: true } : hold;
}

function stoppedCheck(stop: RepairStop, registration: Registration | undefined): z.infer<typeof HeldCheckResult> {
  const seat = singleSeat(registration?.policy.seat);
  return { held: true, reason: `repair stop ${stop.scope}: ${stop.reason}`, stop: stop.scope, ...(seat && { seat }) };
}

const stopStands = (deps: ShepherdDeps, input: HeldWaitInput): boolean => deps.store.get().repairStops().list(input.repo).some((stop) => stop.scope === input.stop);

/**
 * With `untilGreen`, whether the held head's required checks all pass, read at once and then no more often than
 * `CHECKS_RECHECK_MS` of ticks; a head with no PR read yet, or with no required checks, is not green.
 */
function greenWatch(deps: ShepherdDeps, input: HeldWaitInput, tickMs: number): (pr: PullRequest | undefined) => Promise<boolean> {
  let last: PullRequest | undefined;
  let sinceRead = CHECKS_RECHECK_MS;
  return async (pr) => {
    last = pr ?? last;
    if (input.untilGreen !== true || last === undefined || sinceRead < CHECKS_RECHECK_MS) return ((sinceRead += tickMs), false);
    sinceRead = tickMs;
    return greenAtHead(deps.port, input, last, { ...(deps.snapshot && { snapshot: deps.snapshot }) });
  };
}

/**
 * Waits until the hold is released or replaced, or the PR leaves the held head, or, with `untilGreen`, the held head
 * turns green. The store is read every tick and the PR only on a push to its branch or once per backstop; a failed
 * read is read again.
 * A move records the open PR's new head, because shepherd status reads its head from completed results and the
 * next ci-wait has none while it runs.
 */
async function awaitRelease(deps: ShepherdDeps, input: HeldWaitInput, signal: AbortSignal): Promise<z.infer<typeof HeldWaitResult>> {
  const read = () => deps.port.getPr(input.repo, input.pr).catch(() => undefined);
  const poll = headPoll({ pushes: deps.pushes, repo: input.repo, headSha: input.headSha, tickMs: PUSH_WATCH_TICK_MS, read });
  const green = greenWatch(deps, input, poll.tickMs);
  for (;;) {
    signal.throwIfAborted();
    const polled = await poll.next();
    const pr = polled.read ? polled.pr : undefined;
    if (leftHead(pr, input.headSha)) return movedTo(pr);
    if (input.stop === undefined ? holdChanged(deps, input) : !stopStands(deps, input)) {
      // A push from outside the clone while held is seen by no reflog, so the release reads the PR before a repair goes ahead.
      const last = polled.read ? undefined : await read();
      return leftHead(last, input.headSha) ? movedTo(last) : { moved: false };
    }
    if (await green(pr)) return { moved: false, green: true };
    await deps.sleep(poll.tickMs, signal);
  }
}

function holdChanged(deps: ShepherdDeps, input: HeldWaitInput): boolean {
  const now = heldCheck(deps.store.get().byRun(input.runId));
  return !now.held || now.reason !== input.reason;
}

const movedTo = (pr: PullRequest): z.infer<typeof HeldWaitResult> => ({ moved: true, ...(pr.state === "open" && { headSha: pr.headSha }) });

/** The check reads the store at the moment of the wake; the wait only reads, so each repeats safely after a crash. */
export function heldRepairRoutes(deps: ShepherdDeps): StepRoute[] {
  return [
    codeRoute(HELD_CHECK_STEP, deps.now, async (input: HeldInput) => checkHold(deps, input)),
    codeRoute(HELD_WAIT_STEP, deps.now, async (input: HeldWaitInput, signal) => awaitRelease(deps, input, signal)),
  ];
}

/** What the fix round would have fixed: the failing checks, the verdict, or the conflict. */
function causeOf(kind: WakeRequest["kind"], payload: unknown): string {
  if (kind === "conflict") return "the PR conflicts with its base";
  if (kind === "ci-red") {
    const red = RedPayload.safeParse(payload);
    const checks = red.success ? red.data.failing.map((check) => `${check.name} (${check.conclusion ?? "no conclusion"})`).join(", ") : "";
    return `CI failed (${checks || "no failing check named"})`;
  }
  const verdict = VerdictPayload.safeParse(payload);
  return `the review said ${verdict.success ? verdict.data.kind : kind}`;
}

const isRerunStep = (stepId: string): boolean => /^rerun:\d+$/.test(stepId);

interface HeldStepIds {
  check: string;
  wait: string;
}

/**
 * A live check is keyed by round and head, so only this wake's own record can answer it: a run-wide counter let a
 * replay's back-filled `{held:false}` memo answer a later live wake on a held run (TP-2452). A replay whose record
 * goes on with the bare check keeps the bare ids, so a record from before the keying replays as it ran.
 */
function heldStepIds(run: GateRun & { state: LandPrState }, headSha: string): HeldStepIds {
  if (run.ctx.historyNext() === HELD_CHECK_STEP) return { check: HELD_CHECK_STEP, wait: HELD_WAIT_STEP };
  const key = `r${run.state.round}:${headSha}`;
  return { check: `${HELD_CHECK_STEP}:${key}`, wait: `${HELD_WAIT_STEP}:${key}` };
}

/** True while replaying, when the record's next step is not the one this wake would record: the record predates it. */
function recordedWithout(run: GateRun, records: (stepId: string) => boolean): boolean {
  const next = run.ctx.historyNext();
  return next !== undefined && !records(next);
}

const rerunUnlessRecorded = async (run: GateRun & { state: LandPrState }, kind: WakeRequest["kind"], headSha: string, payload: unknown): Promise<boolean> =>
  !recordedWithout(run, isRerunStep) && rerunFlakyHead(run, kind, headSha, payload);

/** A ci-red notice says the one rerun at this head is spent, because a seat that thinks the hold blocks CI deadlocks it. */
const spentRerun = (run: GateRun & { state: LandPrState }, kind: WakeRequest["kind"], headSha: string): string =>
  kind === "ci-red" && headWasRerun(run, headSha) ? `. Shepherd's one rerun of the failed jobs at this head is spent and the head is still red; a rerun that turns it green ends the wait and the review goes ahead with the hold kept` : "";

/**
 * A held run wakes no fixer and spends no repair, so nothing pushes while it is held. The seat is told once per hold,
 * head and cause, and the run waits. Under `heldRepair: on` a g10 hold gates only the merge (decision 423(1)): its check
 * records `repairs` and the repair goes ahead as for an unheld run, the hold kept, so each new head is reviewed and
 * judged again and nothing merges until the hold is released.
 * True means the head moved, or a ci-red head turned green as after a rerun, and the next round lands and reads CI
 * afresh, the hold kept; false means the run is not held, its hold was released at this head, or its hold gates only
 * the merge, and the repair goes ahead as usual. A head ends a wait on green once, so a ci-wait that still
 * reads it red holds it until release or a push.
 * A red head's failed jobs are rerun once per head, held or not, before anything else: a flaky check never wakes the
 * implementer, and a held run never waits on a red that a rerun clears (TP-2836). A rerun pushes nothing, so G10 allows it.
 * The hold check and the reruns shipped in separate deploys, so a replay checks its record before each: a record that
 * went on without one took the path from before it, and a run that landed on that path must not touch CI again.
 */
export async function heldRepair(run: GateRun & { state: LandPrState }, kind: WakeRequest["kind"], headSha: string, payload: unknown): Promise<boolean> {
  if (recordedWithout(run, (stepId) => stepIdMatches(HELD_CHECK_STEP, stepId))) return false;
  const ids = heldStepIds(run, headSha);
  const input: HeldInput = { runId: run.ctx.runId, ...run.target, headSha };
  const untilGreen = kind === "ci-red" && !headsGreen(run).has(headSha);
  for (;;) {
    const hold = await step(run.ctx, ids.check, input, HeldCheckResult);
    if (!hold.held || hold.repairs === true) return rerunUnlessRecorded(run, kind, headSha, payload);
    if (await rerunUnlessRecorded(run, kind, headSha, payload)) return true;
    const reason = hold.reason ?? "held";
    const why = `${hold.stop === undefined ? "the run is held" : "a seat stopped its fixers"} (${reason}), so Shepherd woke no fixer for the ${kind} wake: ${causeOf(kind, payload)}${spentRerun(run, kind, headSha)}`;
    await noticeHeldSeat(run, JSON.stringify(["held", reason, headSha, kind]), { headSha, why, ...(hold.seat && { seat: hold.seat }) });
    const waited = await step(run.ctx, ids.wait, { ...input, reason, ...(untilGreen && { untilGreen }), ...(hold.stop !== undefined && { stop: hold.stop }) }, HeldWaitResult);
    if (waited.green === true) headsGreen(run).add(headSha);
    if (waited.moved || waited.green === true) return true;
  }
}

/** Heads whose held wait ended on green, per run; a replay of the run's steps rebuilds the set. */
const greenHeads = new WeakMap<object, Set<string>>();

const headsGreen = (run: GateRun): Set<string> => greenHeads.get(run.ctx) ?? greenHeads.set(run.ctx, new Set()).get(run.ctx)!;
