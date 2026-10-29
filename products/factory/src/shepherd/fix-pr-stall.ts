import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { isFixersPr, type FreezeStore } from "./freeze.js";
import { noticeHeldSeat } from "./gate-route.js";
import type { GateRun, PrTarget } from "./gates.js";
import type { ShepherdDeps } from "./phases.js";

const FIX_PR_STALL_STEP = "sh-fix-pr-stall";
export const FIX_PR_STALL_STEPS: readonly StepDeclaration[] = [{ id: FIX_PR_STALL_STEP, kind: "dispatch" }];

/** `why` names the unmarked fix PR and the command that marks it; null means the freeze wait is an ordinary one. */
const StallResult = z.looseObject({ why: z.string().nullable() });
type Stall = z.infer<typeof StallResult>;

/**
 * A PR registered against the live episode's fix task that the freeze still holds: its implementer is not the fixer the
 * episode recorded, and no fix PR is marked. Its own merge is what would thaw the freeze, so the thaw wait never ends.
 */
export function unmarkedFixPr(deps: ShepherdDeps, freezes: (() => FreezeStore) | undefined, input: PrTarget): Stall {
  const freeze = freezes?.().get(input.repo);
  const registration = deps.store.get().byPr(input.repo, input.pr);
  if (!freeze || freeze.fixTask === null || freeze.fixPr !== null || registration?.task !== freeze.fixTask || isFixersPr(freeze, registration)) return { why: null };
  const fixer = freeze.fixer === null ? "no fixer is recorded" : `the episode's fixer is ${freeze.fixer}, not ${registration.implementer}`;
  const command = `titan-factory shepherd fix-pr ${input.repo} ${input.pr} --episode ${freeze.episode}`;
  return { why: `frozen against its own fix: registered on ${freeze.fixTask}, the fix task of main-red episode ${freeze.episode}, but ${fixer} and no fix PR is marked. If this PR fixes main, mark it with \`${command}\`` };
}

/**
 * The seat hears once per run and head. A record that already went past this point without the step was made before
 * it existed, so a replay skips it.
 */
export function fixPrStall(run: GateRun): (headSha: string) => Promise<void> {
  return async (headSha) => {
    const next = run.ctx.historyNext();
    if (next !== undefined && !stepIdMatches(FIX_PR_STALL_STEP, next)) return;
    const stall = await step(run.ctx, `${FIX_PR_STALL_STEP}:${headSha}`, run.target, StallResult);
    if (stall.why !== null) await noticeHeldSeat(run, JSON.stringify(["fix-pr-unmarked", headSha]), { headSha, why: stall.why, gate: "fix-pr-unmarked" });
  };
}

export function fixPrStallRoute(deps: ShepherdDeps, freezes: (() => FreezeStore) | undefined): StepRoute {
  return codeRoute(FIX_PR_STALL_STEP, deps.now, async (input: PrTarget) => unmarkedFixPr(deps, freezes, input));
}
