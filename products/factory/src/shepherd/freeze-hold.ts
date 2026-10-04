import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step, type FailingCheck } from "../workflows/land.js";
import { FREEZE_RECHECK_MS, failingAt, greenHead, isFixersPr, type FreezeStore } from "./freeze.js";
import type { PrTarget } from "./gates.js";
import type { ShepherdDeps } from "./phases.js";

const FREEZE_HOLD_STEP = "sh-freeze-hold";
const FREEZE_WAIT_STEP = "sh-freeze-wait";
export const FREEZE_HOLD_STEPS: readonly StepDeclaration[] = [
  { id: FREEZE_HOLD_STEP, kind: "dispatch" },
  { id: FREEZE_WAIT_STEP, kind: "dispatch" },
];
const DEFAULT_POLL_MS = 30_000;

const HoldResult = z.looseObject({ hold: z.boolean(), reason: z.string(), episode: z.number().nullable() });
type Hold = z.infer<typeof HoldResult>;
const WaitResult = z.looseObject({ thawed: z.boolean(), headSha: z.string() });

interface HoldInput extends PrTarget {
  headSha: string;
  failing: string[];
}

interface WaitInput extends PrTarget {
  headSha: string;
  episode: number;
}

/**
 * True when the PR's red head only repeats a frozen main's failures: the hold is recorded, the run waits out the thaw
 * or a new head, and the caller lands the next round so CI is read afresh. No repair is spent and nobody is woken.
 */
export async function heldByFrozenMain(ctx: WorkflowContext, target: PrTarget, red: { headSha: string; failing: FailingCheck[] }, n: number): Promise<boolean> {
  const input: HoldInput = { ...target, headSha: red.headSha, failing: red.failing.map((check) => check.name) };
  const held = await step(ctx, `${FREEZE_HOLD_STEP}:${n}`, input, HoldResult);
  if (!held.hold || held.episode === null) return false;
  await step(ctx, `${FREEZE_WAIT_STEP}:${n}`, { ...target, headSha: red.headSha, episode: held.episode } satisfies WaitInput, WaitResult);
  return true;
}

const pass = (reason: string): Hold => ({ hold: false, reason, episode: null });

/** A read that fails wakes as before, because a held wake that should not have been held costs more than a spent repair. */
async function decideHold(deps: ShepherdDeps, freezes: FreezeStore, input: HoldInput): Promise<Hold> {
  const freeze = freezes.get(input.repo);
  if (!freeze) return pass("the repo is not frozen");
  if (isFixersPr(freeze, deps.store.get().byPr(input.repo, input.pr))) return pass("this is the fixer's PR for the freeze");
  const onMain = new Set(await failingAt(deps.port, input.repo, freeze.redSha).catch(() => [] as string[]));
  const own = input.failing.filter((name) => !onMain.has(name));
  const red = freeze.redSha.slice(0, 7);
  if (input.failing.length === 0 || own.length > 0) return pass(`failing here but not on frozen main at ${red}: ${own.join(", ") || "no check named"}`);
  return { hold: true, reason: `waiting for the thaw: main is frozen red at ${red}, and every failing check (${input.failing.join(", ")}) fails there too`, episode: freeze.episode };
}

/** Thaws through the same green-after-red test the merge guard uses, so a main fixed outside Shepherd still releases its held PRs. */
async function thawIfGreen(port: GitHubPort, freezes: FreezeStore, repo: RepoSlug, baseRef: string, redSha: string): Promise<void> {
  const green = await greenHead(port, repo, baseRef, redSha).catch(() => undefined);
  if (green !== undefined) freezes.unfreeze(repo, green);
}

/** Polls until the hold's episode is no longer live or the PR moves off the held head; a failed read is polled again. */
async function awaitThaw(deps: ShepherdDeps, freezes: FreezeStore, input: WaitInput, signal: AbortSignal): Promise<z.infer<typeof WaitResult>> {
  let lastRecheck = -Infinity;
  for (;;) {
    signal.throwIfAborted();
    const live = freezes.live(input.repo, input.episode);
    if (!live) return { thawed: true, headSha: input.headSha };
    const pr = await deps.port.getPr(input.repo, input.pr).catch(() => undefined);
    if (pr && (pr.headSha !== input.headSha || pr.state !== "open")) return { thawed: false, headSha: pr.headSha };
    if (pr && deps.now() - lastRecheck >= FREEZE_RECHECK_MS) {
      lastRecheck = deps.now();
      await thawIfGreen(deps.port, freezes, input.repo, pr.baseRef, live.redSha);
      continue;
    }
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
  }
}

/** With no freeze store wired, nothing is ever held. */
export function freezeHoldRoutes(deps: ShepherdDeps, freezes: (() => FreezeStore) | undefined): StepRoute[] {
  return [
    codeRoute(FREEZE_HOLD_STEP, deps.now, async (input: HoldInput) => (freezes ? decideHold(deps, freezes(), input) : pass("no freeze store is wired"))),
    codeRoute(FREEZE_WAIT_STEP, deps.now, async (input: WaitInput, signal) => (freezes ? awaitThaw(deps, freezes(), input, signal) : { thawed: true, headSha: input.headSha })),
  ];
}
