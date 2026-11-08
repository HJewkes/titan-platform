import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { SHEPHERD_ACTOR } from "./events.js";
import { isUnreadRegistrationHold } from "./g10-reclass-events.js";
import type { ShepherdDeps } from "./phases.js";
import { isConsumerBumpRun } from "./consumer-bump.js";
import { applyRegistrationHold, g10HoldAt } from "./registration-hold.js";
import type { GateRun } from "./run-state.js";

export const G10_RECLASS_STEP = "sh-g10-reclass";
export const G10_RECLASS_STEPS: readonly StepDeclaration[] = [{ id: G10_RECLASS_STEP, kind: "dispatch" }];

const ReclassInput = z.looseObject({ runId: z.string(), head: z.string() });
type ReclassInput = z.infer<typeof ReclassInput>;
const ReclassResult = z.looseObject({ reclassed: z.boolean(), kept: z.string().optional(), held: z.string().optional() });
type ReclassResult = z.infer<typeof ReclassResult>;

type ReclassDeps = Pick<ShepherdDeps, "port" | "store" | "now" | "sleep" | "prFiles">;

/**
 * A run held because its changed files were unread at registration reads them again at `head`. A whole read that finds no
 * adversary touch lifts the hold through the store's re-class, which keeps any parked hold and marks the release so the
 * adversary rule and merge guard never read it as a seat's review. An adversary touch, or a read that fails again or
 * comes back cut short, keeps the hold as it stands: that read decides nothing, so the run stays failed closed.
 */
export async function reclassUnread(deps: ReclassDeps, input: ReclassInput, signal: AbortSignal): Promise<ReclassResult> {
  const registration = deps.store.get().byRun(input.runId);
  const from = registration?.held ? registration.holdReason : null;
  const unread = from !== null && from !== undefined && isUnreadRegistrationHold(from);
  if (registration && !unread && isConsumerBumpRun(registration)) return classBumpHead(deps, input, signal);
  if (!registration || registration.pr === null || !from || !unread) return { reclassed: false };
  const { repo, pr, base } = registration;
  const target = { repo, pr, head: input.head, pause: (ms: number) => deps.sleep(ms, signal), ...(base !== null && { base }) };
  const wanted = await g10HoldAt(deps.port, target, deps.prFiles);
  if (wanted !== undefined) return { reclassed: false, kept: wanted };
  const placed = deps.store.get().reclassIfHeld(input.runId, from, () => undefined, { actor: SHEPHERD_ACTOR, headSha: input.head });
  return { reclassed: placed !== false };
}

/**
 * A bump run was classed once, as manifests and a lockfile, but the fixer Shepherd starts on it pushes code and, unlike a
 * successor, does not register again; so its head is classed at each CI read as a registration would class it.
 */
async function classBumpHead(deps: ReclassDeps, input: ReclassInput, signal: AbortSignal): Promise<ReclassResult> {
  const files = { head: input.head, pause: (ms: number) => deps.sleep(ms, signal), ...(deps.prFiles && { local: deps.prFiles }) };
  const held = await applyRegistrationHold(deps.port, deps.store.get(), input.runId, files);
  return { reclassed: false, ...(held !== undefined && { held }) };
}

export function g10ReclassRoutes(deps: ReclassDeps): StepRoute[] {
  return [codeRoute(G10_RECLASS_STEP, deps.now, (raw: unknown, signal) => reclassUnread(deps, ReclassInput.parse(raw), signal))];
}

/** Recorded at each CI read; a run replaying history from before this step existed skips it, as its ledger has no row for it. */
export async function reclassAtCiRead(run: Pick<GateRun, "ctx">, headSha: string): Promise<void> {
  const next = run.ctx.historyNext();
  if (next !== undefined && next !== G10_RECLASS_STEP) return;
  await step(run.ctx, G10_RECLASS_STEP, { runId: run.ctx.runId, head: headSha }, ReclassResult);
}
