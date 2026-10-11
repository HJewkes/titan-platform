import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step, type FailingCheck, type LandOutcome } from "../workflows/land.js";
import { UpdateResultResult } from "../workflows/land-steps.js";
import { UPDATE_RESENDS } from "../workflows/land-update.js";
import { FREEZE_RECHECK_MS, failingAt, greenHead, isFixersPr, type FreezeStore, type Red } from "./freeze.js";
import type { PrTarget } from "./gates.js";
import type { ShepherdDeps } from "./phases.js";

const FREEZE_HOLD_STEP = "sh-freeze-hold";
const FREEZE_WAIT_STEP = "sh-freeze-wait";
export const FREEZE_HOLD_STEPS: readonly StepDeclaration[] = [
  { id: FREEZE_HOLD_STEP, kind: "dispatch" },
  { id: FREEZE_WAIT_STEP, kind: "dispatch" },
];
const DEFAULT_POLL_MS = 30_000;
/** How long one wait holds the run before the run reads CI and decides again; a hold that still applies waits again. */
const FREEZE_WAIT_LIMIT_MS = 60 * 60_000;

const HoldResult = z.looseObject({ hold: z.boolean(), reason: z.string(), episode: z.number().nullable(), baseRef: z.string().optional() });
type Hold = z.infer<typeof HoldResult>;
const WaitResult = z.looseObject({ thawed: z.boolean(), headSha: z.string(), expired: z.boolean().optional() });
type Waited = z.infer<typeof WaitResult>;

interface HoldInput extends PrTarget {
  headSha: string;
  failing: string[];
}

interface WaitInput extends PrTarget {
  headSha: string;
  episode: number;
  /** The PR's base when the hold was decided, so main is rechecked even if no read of the PR succeeds during the wait. */
  baseRef?: string;
}

/**
 * True when the PR's red head only repeats a frozen main's failures: the hold is recorded, the run waits out the thaw
 * or a new head, and the caller lands the next round so CI is read afresh. No repair is spent and nobody is woken.
 * A stopped outcome ends the run.
 */
export async function heldByFrozenMain(ctx: WorkflowContext, target: PrTarget, red: { headSha: string; failing: FailingCheck[] }, n: number): Promise<boolean | LandOutcome> {
  const input: HoldInput = { ...target, headSha: red.headSha, failing: red.failing.map((check) => check.name) };
  const held = await step(ctx, `${FREEZE_HOLD_STEP}:${n}`, input, HoldResult);
  if (!held.hold || held.episode === null) return false;
  const waited = await step(ctx, `${FREEZE_WAIT_STEP}:${n}`, { ...target, headSha: red.headSha, episode: held.episode, baseRef: held.baseRef } satisfies WaitInput, WaitResult);
  if (waited.thawed && waited.headSha === red.headSha) return (await refreshRedHead(ctx, target, red, n)) ?? true;
  return true;
}

/**
 * After the thaw this head's CI still shows main's old failures, and a repo that does not require up-to-date heads never
 * reads it as behind, so the next round would spend a repair on it. Main moved past its base: update it. Main did not: rerun.
 * An update GitHub accepted but never applied stops the run as `land` does: the update step already re-sent it, and
 * the next round would read the same red head and spend a repair on main's old failures.
 */
async function refreshRedHead(ctx: WorkflowContext, target: PrTarget, red: { headSha: string; failing: FailingCheck[] }, n: number): Promise<LandOutcome | undefined> {
  const update = await step(ctx, `update-branch:${FREEZE_HOLD_STEP}:${n}`, { ...target, expectedHeadSha: red.headSha }, UpdateResultResult);
  if (update.unmoved) return { kind: "stopped", reason: "update-branch-unmoved", headSha: red.headSha, detail: `update-branch after the thaw: head still ${red.headSha} after ${UPDATE_RESENDS} re-sends` };
  if (update.skipped !== "up-to-date") return undefined;
  await step(ctx, `rerun:${FREEZE_HOLD_STEP}:${n}`, { ...target, headSha: red.headSha, failing: red.failing }, z.looseObject({}));
  return undefined;
}

const pass = (reason: string): Hold => ({ hold: false, reason, episode: null });

/** A freeze store that throws wakes the run as an unfrozen repo would, so a broken store never fails a PR's run. */
async function decideHoldOrPass(deps: ShepherdDeps, freezes: () => FreezeStore, input: HoldInput): Promise<Hold> {
  try {
    return await decideHold(deps, freezes(), input);
  } catch (error) {
    return pass(`the freeze could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A read that fails wakes as before, because a held wake that should not have been held costs more than a spent repair. */
async function decideHold(deps: ShepherdDeps, freezes: FreezeStore, input: HoldInput): Promise<Hold> {
  const freeze = freezes.get(input.repo);
  if (!freeze) return pass("the repo is not frozen");
  if (isFixersPr(freeze, deps.store.get().byPr(input.repo, input.pr))) return pass("this is the fixer's PR for the freeze");
  const onMain = new Set(await failingAt(deps.port, input.repo, freeze.redSha).catch(() => [] as string[]));
  const own = input.failing.filter((name) => !onMain.has(name));
  const red = freeze.redSha.slice(0, 7);
  if (input.failing.length === 0 || own.length > 0) return pass(`failing here but not on frozen main at ${red}: ${own.join(", ") || "no check named"}`);
  const baseRef = await deps.port.getPr(input.repo, input.pr).then((pr) => pr.baseRef, () => undefined);
  return { hold: true, reason: `waiting for the thaw: main is frozen red at ${red}, and every failing check (${input.failing.join(", ")}) fails there too`, episode: freeze.episode, baseRef };
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

/** Polls until the hold's episode is no longer live, the PR moves off the held head, or the wait reaches its limit; a failed read is polled again. */
async function awaitThaw(deps: ShepherdDeps, freezes: FreezeStore, input: WaitInput, signal: AbortSignal): Promise<Waited> {
  const startedAt = deps.now();
  const recheck = mainRecheck(deps.port, freezes, input.repo, input.baseRef);
  for (;;) {
    signal.throwIfAborted();
    const live = freezes.live(input.repo, input.episode);
    if (!live) return { thawed: true, headSha: input.headSha };
    const pr = await deps.port.getPr(input.repo, input.pr).catch(() => undefined);
    if (pr && (pr.headSha !== input.headSha || pr.state !== "open")) return { thawed: false, headSha: pr.headSha };
    if (deps.now() - startedAt >= FREEZE_WAIT_LIMIT_MS) return { thawed: false, expired: true, headSha: input.headSha };
    if (await recheck(deps.now(), pr?.baseRef, live)) continue;
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
  }
}

/** With no freeze store wired, nothing is ever held. */
export function freezeHoldRoutes(deps: ShepherdDeps, freezes: (() => FreezeStore) | undefined): StepRoute[] {
  return [
    codeRoute(FREEZE_HOLD_STEP, deps.now, async (input: HoldInput) => (freezes ? decideHoldOrPass(deps, freezes, input) : pass("no freeze store is wired"))),
    codeRoute(FREEZE_WAIT_STEP, deps.now, async (input: WaitInput, signal) => (freezes ? awaitThaw(deps, freezes(), input, signal) : { thawed: true, headSha: input.headSha })),
  ];
}
