// TP-6776: a visual gate reaches the owner only when there is something to look at. A pr-visual run that failed, or
// succeeded with no frames, is the seat's to diagnose: no owner gate opens, and the run waits for a new head.
import type { CheckRun } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import { noticeHeldSeat } from "./gate-route.js";
import { awaitNewHead } from "./gates.js";
import { LeaveLand } from "./leave-land.js";
import type { PrVisualFrames } from "./spawn-ports.js";
import type { GateRun } from "./run-state.js";

/** The check run the pr-visual workflow's one job posts, named by its job id. */
const PR_VISUAL_CHECK = "pr-visual";
const FAILED = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);

/** What the packet step records about the head's pr-visual run; absent fields were not read or not there. */
export interface VisualRunFacts {
  prVisualConclusion?: string;
  frames?: number;
  framesUnread?: string;
}

/** A rerun posts a new check run at the same head, so the newest one speaks for it. */
function newestRun(runs: readonly CheckRun[], head: string): CheckRun | undefined {
  return runs.filter((run) => run.name === PR_VISUAL_CHECK && run.headSha === head).sort((a, b) => b.id - a.id)[0];
}

/** Frames are read only for a run that succeeded: a failed one is already empty, and a pending one says nothing yet. */
export async function visualRunFacts(runs: readonly CheckRun[], repo: string, head: string, frames?: PrVisualFrames): Promise<VisualRunFacts> {
  const conclusion = newestRun(runs, head)?.conclusion ?? undefined;
  if (conclusion === undefined) return {};
  if (conclusion !== "success" || frames === undefined) return { prVisualConclusion: conclusion };
  const count = await frames(repo, head);
  return typeof count === "number" ? { prVisualConclusion: conclusion, frames: count } : { prVisualConclusion: conclusion, framesUnread: count };
}

/** Why the head has nothing to show the owner, or undefined when it may; no run or an unread count keeps the gate. */
export function nothingToSee(facts: VisualRunFacts): string | undefined {
  const { prVisualConclusion: conclusion, frames } = facts;
  if (conclusion !== undefined && FAILED.has(conclusion)) return `the pr-visual run concluded ${conclusion}`;
  return conclusion === "success" && frames === 0 ? "the pr-visual run succeeded with zero frames rendered" : undefined;
}

type Asked = ReturnType<WorkflowContext["assisted"]>;

/**
 * Only approve-merge is routed: the regenerated-baselines ask stands at a red head by design. A told seat leaves land
 * to wait for a new head; a notice that could not go out opens the owner gate, saying why.
 */
export async function routeEmptyVisualRun(run: GateRun, stepId: string, headSha: string, empty: string, open: (note: string) => Asked): Asked {
  if (!stepIdMatches("approve-merge", stepId)) return open("");
  const why = `${empty}, so the visual gate has nothing for the owner to look at`;
  const told = await noticeHeldSeat(run, JSON.stringify(["visual-empty", headSha]), { headSha, why, gate: "visual-empty" });
  if (told?.sent !== false) throw new LeaveLand(await awaitNewHead(run, headSha));
  return open(`\n\nNothing to look at: ${why}; the seat notice could not go out (${told.detail}).`);
}
