import type { RepoSlug } from "@titan-design/github";
import { EXIT } from "@titan-design/registry";
import { SHEPHERD_ACTOR } from "./events.js";
import { GATE_NAME, type GateEvidence } from "./gate-evidence.js";
import type { HoldSatisfier } from "./hold.js";
import type { ShepherdStore } from "./store.js";

export { gateEvidenceMigration } from "./gate-evidence.js";

/**
 * Gates that cannot run in GitHub Actions, such as a check against a device on the local network. The reason names them,
 * `lan-gates: <gate>, <gate>; <detail>`, and the hold releases itself once each has a green record at the PR's head.
 */
export const LAN_GATES_CLASS = "lan-gates";
const PREFIX = `${LAN_GATES_CLASS}:`;

/** The gates a `lan-gates` reason names, between its class and the first ";"; undefined for a reason of any other class. */
function gatesOf(reason: string): string[] | undefined {
  if (!reason.startsWith(PREFIX)) return undefined;
  const list = reason.slice(PREFIX.length).split(";")[0] ?? "";
  return [...new Set(list.split(",").map((gate) => gate.trim()))].filter((gate) => gate !== "");
}

/** Syntax only, so `checkHoldReason` stays pure; whether each gate is declared is `refuseUnknownGates`'s to read. */
export function gateListRefusal(reason: string): string | undefined {
  const gates = gatesOf(reason) ?? [];
  const bad = gates.filter((gate) => !GATE_NAME.test(gate));
  if (gates.length > 0 && bad.length === 0) return undefined;
  return `hold refused, nothing was held: a ${LAN_GATES_CLASS} hold names its gates as "${PREFIX} <gate>, <gate>; <detail>", and ${bad.length > 0 ? `"${bad.join('", "')}" is not a gate name` : "it names none"}`;
}

/** A hold naming a gate no evidence can ever be recorded for would never release itself, so it is refused before anything is held. */
export function refuseUnknownGates(evidence: GateEvidence, reason: string): void {
  const unknown = (gatesOf(reason) ?? []).filter((gate) => !evidence.known(gate));
  if (unknown.length === 0) return;
  const message = `hold refused, nothing was held: ${unknown.join(", ")} ${unknown.length === 1 ? "is not a declared gate" : "are not declared gates"}, so no evidence could release it`;
  throw Object.assign(new Error(message), { code: EXIT.DATAERR });
}

/** True when every named gate's newest record at exactly `head` is green; none at that head, or a red one, keeps the hold. */
const gatesGreenAt = (evidence: GateEvidence, repo: string, head: string, gates: readonly string[]): boolean =>
  gates.length > 0 && gates.every((gate) => evidence.conclusionAt(repo, head, gate) === "success");

/**
 * Releases the run's gating `lan-gates` hold when its gates are green at `head`. A hold naming a reviewer waits for that reviewer,
 * as a g10-review one does. The release is a compare-and-swap on the reason judged, so a re-hold in between stands.
 */
function releaseOnGateEvidence(store: ShepherdStore, repo: RepoSlug, pr: number, head: string): boolean {
  const registration = store.byPr(repo, pr);
  const reason = registration?.held ? registration.holdReason : null;
  const gates = reason === null ? undefined : gatesOf(reason);
  if (!registration || reason === null || !gates || registration.holdReviewer !== null) return false;
  if (!gatesGreenAt(store.gateEvidence(), repo, head, gates)) return false;
  return store.releaseIfHeld(registration.runId, reason, { actor: SHEPHERD_ACTOR, headSha: head });
}

/**
 * The merge wait and the merge port call the satisfier only at the PR's head as read just then, so evidence that lands while the
 * run waits releases the hold at its next poll, and evidence for any older head never does.
 */
export function lanGatesSatisfier(store: () => ShepherdStore, inner?: HoldSatisfier): HoldSatisfier {
  return async (repo, pr, sha, baseRef) => {
    await inner?.(repo, pr, sha, baseRef);
    releaseOnGateEvidence(store(), repo, pr, sha);
  };
}
