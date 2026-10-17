import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { configPath, loadConfig } from "../config.js";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { visualAcceptDecision } from "../gate-brief.js";
import { codeRoute, step, type LandOutcome } from "../workflows/land.js";
import { unhandledSendBack } from "./gate-route.js";
import type { GateRun } from "./gates.js";
import { OWNER_SEND_BACK_KIND, ownerSendBackOf, type OwnerSendBackPayload } from "./owner-send-back.js";
import type { VisualSetCarry } from "./phases.js";
import { askAtHead } from "./stale-gates.js";

const OFFER_STEP = "sh-visual-accept-offer";
export const VISUAL_ACCEPT_GATE = "sh-visual-accept";
export const VISUAL_ACCEPT_STEPS: readonly StepDeclaration[] = [
  { id: OFFER_STEP, kind: "dispatch", orphanSafe: true },
  { id: VISUAL_ACCEPT_GATE, kind: "assisted" },
];

const ACCEPT_PROMPT = /^Accept the regenerated baselines of PR #\d+ in \S+ at head ([0-9a-f]{40})\? CI is red only on /;

/** The head an `sh-visual-accept` gate pins; any other gate is none. */
export function visualAcceptHead(stepId: string, prompt: string): string | undefined {
  return stepIdMatches(VISUAL_ACCEPT_GATE, stepId) ? ACCEPT_PROMPT.exec(prompt)?.[1] : undefined;
}

const Mode = z.enum(["off", "shadow", "on"]);
const OfferInput = z.looseObject({ repo: z.string(), failing: z.array(z.string()), mode: Mode.optional() });
const OfferResult = z.looseObject({ offered: z.boolean(), mode: Mode, check: z.string().nullable() });

/** The set the owner accepted at a red head, as the gate answer carries it; a later head of the run is checked against it. */
type AcceptedSet = { fromHead: string } & Record<string, unknown>;

export interface VisualAcceptRun extends GateRun {
  visualAcceptOffers: number;
  acceptedSet?: AcceptedSet;
}

type RedHead = Extract<LandOutcome, { kind: "ci-failed" }>;

/** `wake` goes to the fixer through the review wake; `left` ends the ci-failed route with that outcome. */
/** Runs just before the gate opens, as the visual packet trigger does before a visual land gate. */
type BeforeAsk = (stepId: string, prompt: string) => Promise<void>;

type VisualAccept = { kind: "not-offered" } | { kind: "wake"; payload: OwnerSendBackPayload } | { kind: "left"; outcome: LandOutcome | undefined };

/** `shepherd.visualSetCarry` as the config file reads now; a config that does not parse offers nothing. */
export function configuredVisualSetCarry(env: NodeJS.ProcessEnv = process.env): VisualSetCarry {
  try {
    return loadConfig(configPath(env)).shepherd?.visualSetCarry ?? "off";
  } catch {
    return "off";
  }
}

/**
 * The flag is read only where the run is live and recorded with the seat's check, so a replay rebuilds the gate it
 * opened whatever the config reads now. With the flag off nothing is recorded, and a record that goes on to any other
 * step, or a run resumed on a gate, predates the offer and replays as it ran.
 */
async function offer(run: VisualAcceptRun, red: RedHead, liveMode: () => VisualSetCarry): Promise<z.infer<typeof OfferResult> | undefined> {
  const { ctx } = run;
  const next = ctx.historyNext();
  if (next !== undefined && !stepIdMatches(OFFER_STEP, next)) return undefined;
  const mode = next === undefined ? liveMode() : undefined;
  if (mode === "off" || (next === undefined && ctx.resumedGate() !== undefined)) return undefined;
  const input = { ...run.target, headSha: red.headSha, failing: red.failing.map((check) => check.name), ...(mode && { mode }) };
  return step(ctx, `${OFFER_STEP}:${run.visualAcceptOffers++}`, input, OfferResult);
}

/** Asks the owner at a head red only on the seat's baseline check whether CI's regenerated set is the one to commit. */
export async function askVisualAccept(run: VisualAcceptRun, red: RedHead, liveMode: () => VisualSetCarry = () => "off", beforeAsk?: BeforeAsk): Promise<VisualAccept> {
  const offered = await offer(run, red, liveMode);
  if (!offered?.offered || offered.check === null) return { kind: "not-offered" };
  const { repo, pr } = run.target;
  const { schema, brief } = visualAcceptDecision({ repo, pr, headSha: red.headSha, check: offered.check });
  const prompt = `Accept the regenerated baselines of PR #${pr} in ${repo} at head ${red.headSha}? CI is red only on ${offered.check}.`;
  await beforeAsk?.(VISUAL_ACCEPT_GATE, prompt);
  const answered = await askAtHead(run.ctx, VISUAL_ACCEPT_GATE, prompt, { schema, brief });
  if (!answered) return { kind: "left", outcome: undefined };
  const answer = schema.parse(answered.data);
  if (answer.decision === "abandon") return { kind: "left", outcome: { kind: "stopped", reason: "abandoned", headSha: red.headSha, detail: "a human abandoned the PR at its regenerated baselines" } };
  if (answer.decision === "accept-set") run.acceptedSet = answer.approvedSet;
  return { kind: "wake", payload: ownerSendBackOf(answer.note ?? "", answer.decision === "accept-set" ? "accepted" : "sent-back") };
}

export const NOT_OFFERED = "not-offered";
type WakeFixer = (payload: OwnerSendBackPayload) => Promise<boolean>;
type AcceptRouted = LandOutcome | undefined | typeof NOT_OFFERED;

/**
 * The ci-failed route's owner ask: an answer ends it, the owner's words through `wake` and, with no taker, the seat's
 * fix round; `NOT_OFFERED` goes on to the ci-red wake as today.
 */
export async function visualAcceptRoute(run: VisualAcceptRun, red: RedHead, liveMode: (() => VisualSetCarry) | undefined, wake: WakeFixer, beforeAsk?: BeforeAsk): Promise<AcceptRouted> {
  const accept = await askVisualAccept(run, red, liveMode, beforeAsk);
  if (accept.kind !== "wake") return accept.kind === "left" ? accept.outcome : NOT_OFFERED;
  return (await wake(accept.payload)) ? undefined : unhandledSendBack(run, OWNER_SEND_BACK_KIND, red.headSha, accept.payload.text);
}

/** Offered only when every failing check is the seat's one baseline check, so any other red goes to the fixer as today. */
function offerOf(input: z.infer<typeof OfferInput>, checkOf: (repo: string) => string | undefined): z.infer<typeof OfferResult> {
  const mode = input.mode ?? "off";
  const check = checkOf(input.repo) ?? null;
  const onlyCheck = check !== null && input.failing.length > 0 && input.failing.every((name) => name === check);
  return { offered: mode !== "off" && onlyCheck, mode, check };
}

export const visualAcceptOfferRoute = (deps: { now: () => number; visualBaselineCheck?: (repo: string) => string | undefined }): StepRoute =>
  codeRoute(OFFER_STEP, deps.now, async (raw: unknown) => offerOf(OfferInput.parse(raw), deps.visualBaselineCheck ?? (() => undefined)));
