import { headRegressionObserver } from "../head-guard/head-regression.js";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step, type FailingCheck, type LandOutcome } from "../workflows/land.js";
import { UpdateResultResult } from "../workflows/land-steps.js";
import { UPDATE_RESENDS } from "../workflows/land-update.js";
import { failingNotIn, failureReader, redRunsAt, type FailureReader } from "./failing-step.js";
import { FREEZE_RECHECK_MS, actionsRunsAt, greenHead, isFixersPr, type FreezeStore, type Red } from "./freeze.js";
import { fixPrStallRoute } from "./fix-pr-stall.js";
import { noticeHeldSeat } from "./gate-route.js";
import { countMainFixedMergeUp, mainFixedSince, mainFixedSpent } from "./main-fixed.js";
import type { GateRun, PrTarget } from "./gates.js";
import { singleSeat } from "./held-repair.js";
import type { ShepherdDeps } from "./phases.js";
import type { CauseTrail } from "./review-cause.js";
import { PUSH_WATCH_TICK_MS, headPoll, type HeadPoll } from "./push-signal.js";

const FREEZE_HOLD_STEP = "sh-freeze-hold";
const FREEZE_WAIT_STEP = "sh-freeze-wait";
const BASE_WAIT_STEP = "sh-base-wait";
export const FREEZE_HOLD_STEPS: readonly StepDeclaration[] = [
  { id: FREEZE_HOLD_STEP, kind: "dispatch" },
  { id: FREEZE_WAIT_STEP, kind: "dispatch" },
  { id: BASE_WAIT_STEP, kind: "dispatch" },
];
/** How long one wait holds the run before the run reads CI and decides again; a hold that still applies waits again. */
const FREEZE_WAIT_LIMIT_MS = 60 * 60_000;
/** The most base commits read back from the base head to find the one a red head's CI ran against. */
const CI_BASE_WALK = 20;

/**
 * The base the hold waits past, red on every check the PR's head fails, at the same step with the same failures; records from before base-red carry none. `stale`:
 * the head's CI ran against this base commit, and the base head has already moved past it. `mainFixed`: the later base
 * commit that went green on every failing check, when the red was read from the base's last finished runs, past any
 * cancelled ones at this commit.
 */
const BaseRed = z.object({ baseRef: z.string(), baseSha: z.string(), seat: z.string().optional(), stale: z.boolean().optional(), mainFixed: z.string().optional() });
type BaseRed = z.infer<typeof BaseRed>;
const HoldResult = z.looseObject({ hold: z.boolean(), reason: z.string(), episode: z.number().nullable(), baseRef: z.string().optional(), baseRed: BaseRed.optional() });
type Hold = z.infer<typeof HoldResult>;
const WaitResult = z.looseObject({ thawed: z.boolean(), headSha: z.string(), expired: z.boolean().optional() });
type Waited = z.infer<typeof WaitResult>;
const BaseWaitResult = z.looseObject({ baseMoved: z.boolean(), headSha: z.string(), expired: z.boolean().optional() });
type BaseWaited = z.infer<typeof BaseWaitResult>;

interface HoldInput extends PrTarget {
  headSha: string;
  failing: string[];
  /** The run has made its main-fixed merge-ups, so a base green since the CI base holds nothing. */
  mainFixedSpent?: boolean;
}

interface WaitInput extends PrTarget {
  headSha: string;
  episode: number;
  /** The PR's base when the hold was decided, so main is rechecked even if no read of the PR succeeds during the wait. */
  baseRef?: string;
}

interface BaseWaitInput extends PrTarget {
  headSha: string;
  baseRef: string;
  baseSha: string;
}

type RedHead = { headSha: string; failing: FailingCheck[] };
/** `trail` takes each head the refresh makes: the hold runs on the run's own context, which records no update. */
type HoldRun = GateRun & { trail: CauseTrail };

/**
 * True when the PR's red head only repeats a frozen main's failures, or its base head's: the hold is recorded, the run
 * waits out the thaw, the base's move or a new head, and the caller lands the next round so CI is read afresh. No repair
 * is spent and nobody is woken. A stopped outcome ends the run.
 */
export async function heldByFrozenMain(run: HoldRun, red: RedHead, n: number): Promise<boolean | LandOutcome> {
  const { ctx, target } = run;
  const input: HoldInput = { ...target, headSha: red.headSha, failing: red.failing.map((check) => check.name), ...(mainFixedSpent(run) && { mainFixedSpent: true }) };
  const held = await step(ctx, `${FREEZE_HOLD_STEP}:${n}`, input, HoldResult);
  if (held.hold && held.baseRed?.mainFixed !== undefined) countMainFixedMergeUp(run);
  if (held.hold && held.baseRed) return heldByRedBase(run, red, held, held.baseRed, n);
  if (!held.hold || held.episode === null) return false;
  const waited = await step(ctx, `${FREEZE_WAIT_STEP}:${n}`, { ...target, headSha: red.headSha, episode: held.episode, baseRef: held.baseRef } satisfies WaitInput, WaitResult);
  if (waited.thawed && waited.headSha === red.headSha) return (await refreshRedHead(run, red, n)) ?? true;
  return true;
}

/**
 * The seat is told once per base and head; once the base moves past this head's base, the head is refreshed as after a
 * thaw. A stale base already moved, so nothing waits on the seat and the head is merged up at once.
 */
async function heldByRedBase(run: HoldRun, red: RedHead, held: Hold, base: BaseRed, n: number): Promise<boolean | LandOutcome> {
  if (!base.stale) await noticeHeldSeat(run, JSON.stringify(["base-red", base.baseSha, red.headSha]), { headSha: red.headSha, why: `base-red: ${held.reason}`, gate: "base-red", ...(base.seat && { seat: base.seat }) });
  const input: BaseWaitInput = { ...run.target, headSha: red.headSha, baseRef: base.baseRef, baseSha: base.baseSha };
  const waited = await step(run.ctx, `${BASE_WAIT_STEP}:${n}`, input, BaseWaitResult);
  if (waited.baseMoved && waited.headSha === red.headSha) return (await refreshRedHead(run, red, n)) ?? true;
  return true;
}

/**
 * After the thaw this head's CI still shows main's old failures, and a repo that does not require up-to-date heads never
 * reads it as behind, so the next round would spend a repair on it. Main moved past its base: update it. Main did not: rerun.
 * An update GitHub accepted but never applied stops the run as `land` does: the update step already re-sent it, and
 * the next round would read the same red head and spend a repair on main's old failures.
 */
async function refreshRedHead({ ctx, target, trail }: HoldRun, red: RedHead, n: number): Promise<LandOutcome | undefined> {
  const update = await step(ctx, `update-branch:${FREEZE_HOLD_STEP}:${n}`, { ...target, expectedHeadSha: red.headSha }, UpdateResultResult);
  if (update.own) trail.updated.add(update.headSha);
  if (update.unmoved) return { kind: "stopped", reason: "update-branch-unmoved", headSha: red.headSha, detail: `update-branch after the thaw: head still ${red.headSha} after ${UPDATE_RESENDS} re-sends` };
  if (update.skipped !== "up-to-date") return undefined;
  await step(ctx, `rerun:${FREEZE_HOLD_STEP}:${n}`, { ...target, headSha: red.headSha, failing: red.failing }, z.looseObject({}));
  return undefined;
}

const pass = (reason: string): Hold => ({ hold: false, reason, episode: null });

const failureOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A freeze store that throws wakes the run as an unfrozen repo would, so a broken store never fails a PR's run. */
export async function decideHoldOrPass(deps: ShepherdDeps, freezes: (() => FreezeStore) | undefined, input: HoldInput): Promise<Hold> {
  try {
    return await decideHold(deps, freezes?.(), input);
  } catch (error) {
    return pass(`the freeze could not be read: ${failureOf(error)}`);
  }
}

/** A read that fails wakes as before, because a held wake that should not have been held costs more than a spent repair. */
async function decideHold(deps: ShepherdDeps, freezes: FreezeStore | undefined, input: HoldInput): Promise<Hold> {
  const freeze = freezes?.get(input.repo);
  if (!freeze) return decideBaseRed(deps, input, freezes ? "the repo is not frozen" : "no freeze store is wired");
  if (isFixersPr(freeze, deps.store.get().byPr(input.repo, input.pr))) return pass("this is the fixer's PR for the freeze");
  const own = await redRunsAt(deps.port, input.repo, freeze.redSha).then((red) => failingNotIn(deps.port, input, red)).catch(() => input.failing);
  const red = freeze.redSha.slice(0, 7);
  if (input.failing.length === 0 || own.length > 0) return pass(`failing here but not on frozen main at ${red}: ${own.join(", ") || "no check named"}`);
  const baseRef = await deps.port.getPr(input.repo, input.pr).then((pr) => pr.baseRef, () => undefined);
  return { hold: true, reason: `waiting for the thaw: main is frozen red at ${red}, and every failing check (${input.failing.join(", ")}) fails there too at the same step with the same failures`, episode: freeze.episode, baseRef };
}

/**
 * The failing checks of `input` that are not red at `sha` at the same step with the same failures. A check whose newest
 * run there was cancelled does not count: like `redOnlyFromCancels`, a cancel is no red the base owns.
 */
async function notRedAt(port: GitHubPort, input: HoldInput, sha: string, read: FailureReader): Promise<string[]> {
  return failingNotIn(port, input, await redRunsAt(port, input.repo, sha, (run) => run.conclusion !== "cancelled"), read);
}

/** When the earliest failing run at the head started, since a pull_request run tests the base as it stood then. */
async function failingStartedAt(port: GitHubPort, input: HoldInput): Promise<number | undefined> {
  const runs = actionsRunsAt(await port.latestCheckRuns(input.repo, input.headSha), input.headSha).filter((run) => input.failing.includes(run.name));
  const starts = runs.map((run) => Date.parse(run.startedAt ?? ""));
  return starts.length === 0 || starts.some(Number.isNaN) ? undefined : Math.min(...starts);
}

/**
 * The base commit the head's failing CI ran against: the newest first-parent ancestor of the base head that landed by
 * the earliest failing run's start. Undefined when that is the base head itself, or a date is missing, or the walk runs
 * out, so a doubtful read wakes as before.
 */
async function ciBaseOf(port: GitHubPort, input: HoldInput, baseSha: string): Promise<string | undefined> {
  const startedAt = await failingStartedAt(port, input);
  if (startedAt === undefined) return undefined;
  let sha: string | undefined = baseSha;
  for (let hop = 0; hop < CI_BASE_WALK && sha !== undefined; hop++) {
    const commit = await port.getCommit(input.repo, sha);
    const committedAt = Date.parse(commit.committedAt ?? "");
    if (Number.isNaN(committedAt)) return undefined;
    if (committedAt <= startedAt) return sha === baseSha ? undefined : sha;
    sha = commit.parents[0];
  }
  return undefined;
}

function baseRedHold(deps: ShepherdDeps, input: HoldInput, base: Omit<BaseRed, "seat">, why: string): Hold {
  const seat = singleSeat(deps.store.get().byPr(input.repo, input.pr)?.policy.seat);
  const reason = `${why}, and every failing check (${input.failing.join(", ")}) fails there too at the same step with the same failures`;
  return { hold: true, reason, episode: null, baseRed: { ...base, ...(seat && { seat }) } };
}

/**
 * A stale hold, merged up at once, when the since-moved base this head's CI ran against is red on every failing check,
 * or when the base's last finished runs of them at or before it were and a later base commit is green on them
 * (TP-4650), unless the run has spent its main-fixed merge-ups. A main-fixed read that fails holds nothing.
 */
async function staleBaseHold(deps: ShepherdDeps, input: HoldInput, base: { baseRef: string; baseSha: string; ciBase: string }, read: FailureReader): Promise<Hold | undefined> {
  const { baseRef, baseSha, ciBase } = base;
  const moved = `this head's CI ran against ${baseRef} at ${ciBase.slice(0, 7)}`;
  const staleRed = { baseRef, baseSha: ciBase, stale: true };
  if ((await notRedAt(deps.port, input, ciBase, read)).length === 0) return baseRedHold(deps, input, staleRed, `${moved}, red there and since moved to ${baseSha.slice(0, 7)}`);
  if (input.mainFixedSpent === true) return undefined;
  const green = await mainFixedSince({ port: deps.port, repo: input.repo, headSha: input.headSha, baseRef, baseSha, ciBase, failing: input.failing, failures: read }).catch(() => undefined);
  if (green === undefined) return undefined;
  const why = `${moved}, where ${baseRef}'s last finished runs of the failing checks were red, and it went green on them at ${green.slice(0, 7)}`;
  return baseRedHold(deps, input, { ...staleRed, mainFixed: green }, why);
}

/**
 * Holds a red head whose every failing check also fails at the PR's base head, or at the since-moved base its CI ran
 * against, or whose last finished runs there were red and has since gone green on the base, so a fixer is never woken
 * to repair the base's red. Any read that fails passes, as does a base with no completed red run there (R5:
 * path-filtered base CI) or only cancelled ones.
 */
async function decideBaseRed(deps: ShepherdDeps, input: HoldInput, unfrozen: string): Promise<Hold> {
  if (input.failing.length === 0) return pass(unfrozen);
  try {
    const { baseRef } = await deps.port.getPr(input.repo, input.pr);
    const baseSha = await deps.port.getHeadSha(input.repo, baseRef);
    if (baseSha === null) return pass(`${unfrozen}; the base ${baseRef} has no head`);
    const read = failureReader(deps.port, input.repo);
    const own = await notRedAt(deps.port, input, baseSha, read);
    if (own.length === 0) return baseRedHold(deps, input, { baseRef, baseSha }, `the base ${baseRef} is red at ${baseSha.slice(0, 7)}`);
    const ciBase = await ciBaseOf(deps.port, input, baseSha).catch(() => undefined);
    const stale = ciBase === undefined ? undefined : await staleBaseHold(deps, input, { baseRef, baseSha, ciBase }, read);
    return stale ?? pass(`${unfrozen}; failing here but not on ${baseRef} at ${baseSha.slice(0, 7)}: ${own.join(", ")}`);
  } catch (error) {
    return pass(`${unfrozen}; the base could not be read: ${failureOf(error)}`);
  }
}

/** Thaws through the same green-after-red test the merge guard uses, so a main fixed outside Shepherd still releases its held PRs. */
async function thawIfGreen(port: GitHubPort, freezes: FreezeStore, repo: RepoSlug, baseRef: string, red: Red): Promise<void> {
  const green = await greenHead(port, repo, baseRef, red).catch(() => undefined);
  if (green !== undefined) freezes.unfreeze(repo, green);
}

/**
 * Re-reads main at most every `FREEZE_RECHECK_MS` whether or not this poll's PR read succeeded, from the last base the
 * PR named. True when this call re-read main.
 */
function mainRecheck(port: GitHubPort, freezes: FreezeStore, repo: RepoSlug, heldBase: string | undefined) {
  let last = -Infinity;
  let base = heldBase;
  return async (at: number, baseRef: string | undefined, red: Red): Promise<boolean> => {
    base = baseRef ?? base;
    if (base === undefined || at - last < FREEZE_RECHECK_MS) return false;
    last = at;
    await thawIfGreen(port, freezes, repo, base, red);
    return true;
  };
}

/** The freeze is a local read made every tick; the PR is read on a push to its branch or once per backstop, and a failed read is read again. */
const prPoll = (deps: ShepherdDeps, input: PrTarget & { headSha: string }): HeadPoll =>
  headPoll({
    pushes: deps.pushes,
    repo: input.repo,
    headSha: input.headSha,
    tickMs: PUSH_WATCH_TICK_MS,
    read: () => deps.port.getPr(input.repo, input.pr).catch(() => undefined),
    observe: headRegressionObserver(deps.port),
  });

/** Waits until the hold's episode is no longer live, the PR moves off the held head, or the wait reaches its limit. */
async function awaitThaw(deps: ShepherdDeps, freezes: FreezeStore, input: WaitInput, signal: AbortSignal): Promise<Waited> {
  const startedAt = deps.now();
  const recheck = mainRecheck(deps.port, freezes, input.repo, input.baseRef);
  const poll = prPoll(deps, input);
  for (;;) {
    signal.throwIfAborted();
    const live = freezes.live(input.repo, input.episode);
    if (!live) return { thawed: true, headSha: input.headSha };
    const polled = await poll.next();
    const pr = polled.read ? polled.pr : undefined;
    if (pr && (pr.headSha !== input.headSha || pr.state !== "open")) return { thawed: false, headSha: pr.headSha };
    if (deps.now() - startedAt >= FREEZE_WAIT_LIMIT_MS) return { thawed: false, expired: true, headSha: input.headSha };
    if (await recheck(deps.now(), pr?.baseRef, live)) continue;
    await deps.sleep(poll.tickMs, signal);
  }
}

/**
 * Waits until the PR's base head is no longer the red one, the PR moves off the held head, or the wait reaches its
 * limit. The base is read along with each read of the PR.
 */
async function awaitBaseMove(deps: ShepherdDeps, input: BaseWaitInput, signal: AbortSignal): Promise<BaseWaited> {
  const startedAt = deps.now();
  const poll = prPoll(deps, input);
  for (;;) {
    signal.throwIfAborted();
    const polled = await poll.next();
    const pr = polled.read ? polled.pr : undefined;
    if (pr && (pr.headSha !== input.headSha || pr.state !== "open")) return { baseMoved: false, headSha: pr.headSha };
    const base = polled.read ? await deps.port.getHeadSha(input.repo, pr?.baseRef ?? input.baseRef).catch(() => undefined) : undefined;
    if (base != null && base !== input.baseSha) return { baseMoved: true, headSha: input.headSha };
    if (deps.now() - startedAt >= FREEZE_WAIT_LIMIT_MS) return { baseMoved: false, expired: true, headSha: input.headSha };
    await deps.sleep(poll.tickMs, signal);
  }
}

/** With no freeze store wired, only a red base holds a run. */
export function freezeHoldRoutes(deps: ShepherdDeps, freezes: (() => FreezeStore) | undefined): StepRoute[] {
  return [
    codeRoute(FREEZE_HOLD_STEP, deps.now, async (input: HoldInput) => decideHoldOrPass(deps, freezes, input)),
    codeRoute(FREEZE_WAIT_STEP, deps.now, async (input: WaitInput, signal) => (freezes ? awaitThaw(deps, freezes(), input, signal) : { thawed: true, headSha: input.headSha })),
    codeRoute(BASE_WAIT_STEP, deps.now, async (input: BaseWaitInput, signal) => awaitBaseMove(deps, input, signal)),
    fixPrStallRoute(deps, freezes),
  ];
}
