import { dataFence } from "@titan-design/agent-dispatch";
import type { GitHubPort } from "@titan-design/github";
import { findingsText } from "@titan-design/review-panel";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { failureOf } from "./error-class.js";
import type { GateRun } from "./gates.js";
import type { WakeRequest } from "./phases.js";

const HELD_VERDICT_STEP = "sh-held-verdict";
export const HELD_VERDICT_STEPS: readonly StepDeclaration[] = [{ id: HELD_VERDICT_STEP, kind: "dispatch" }];

const FixFirstPayload = z.looseObject({ kind: z.literal("FIX_FIRST"), text: z.string() });

/**
 * The reviewer's findings of a FIX_FIRST send-back, block lines stripped so no posted copy parses as a verdict; undefined
 * for any other wake, or a verdict that names none.
 */
export function heldFindings(kind: WakeRequest["kind"], payload: unknown): string | undefined {
  const parsed = kind === "review" ? FixFirstPayload.safeParse(payload) : undefined;
  const findings = parsed?.success ? findingsText(parsed.data.text) : "";
  return findings === "" ? undefined : findings;
}

/** One marker per head, so a second refusal at the same verdict finds the comment instead of posting again. */
export const heldVerdictMarker = (head: string): string => `<!-- shepherd-held-verdict:${head} -->`;

/** Names no seat, agent or refusal detail: the PR may be public, and the seat notice carries why. */
export function heldVerdictComment(head: string, findings: string): string {
  return [
    heldVerdictMarker(head),
    "",
    `**Shepherd: an independent review of \`${head.slice(0, 7)}\` returned FIX_FIRST, and no fixer could start.** Push a fix to this branch; the run waits for a new head.`,
    "",
    dataFence("review findings", findings),
    "",
  ].join("\n");
}

const HeldVerdictInput = z.object({ repo: z.string().min(1), pr: z.number().int().positive(), headSha: z.string().min(1), findings: z.string().min(1) });
const HeldVerdictResult = z.looseObject({ posted: z.boolean(), detail: z.string() });
type HeldVerdictResult = z.infer<typeof HeldVerdictResult>;

/** Never throws: a failed post is recorded, and the seat notice still carries the findings. */
export async function postHeldVerdict(port: GitHubPort, input: z.infer<typeof HeldVerdictInput>): Promise<HeldVerdictResult> {
  try {
    const comment = await port.upsertComment(input.repo, input.pr, heldVerdictMarker(input.headSha), heldVerdictComment(input.headSha, input.findings));
    return comment.done ? { posted: true, detail: `comment ${comment.id}` } : { posted: false, detail: `comment ${comment.id} already holds the findings` };
  } catch (error) {
    return { posted: false, detail: `the findings comment failed: ${failureOf(error)}` };
  }
}

export const heldVerdictRoute = (port: GitHubPort, now: () => number): StepRoute =>
  codeRoute(HELD_VERDICT_STEP, now, async (raw: unknown) => postHeldVerdict(port, HeldVerdictInput.parse(raw)));

/** A run recorded before this step went straight to the seat notice or the sent-back gate, and replays that way. */
function recordedWithoutComment(run: GateRun): boolean {
  const next = run.ctx.historyNext();
  if (next !== undefined) return !stepIdMatches(HELD_VERDICT_STEP, next);
  return run.ctx.resumedGate() !== undefined;
}

/** Posts a held FIX_FIRST's findings on the PR once per head, recorded as a step so a replay reads the record. */
export async function commentHeldVerdict(run: GateRun, headSha: string, findings: string | undefined): Promise<void> {
  if (findings === undefined || recordedWithoutComment(run)) return;
  await step(run.ctx, `${HELD_VERDICT_STEP}:${headSha}`, { ...run.target, headSha, findings }, HeldVerdictResult);
}
