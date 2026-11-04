import type { GateAuthorize, GateEvidencePolicy, GateRecord, GateResolver } from "@titan-design/hitl";
import { landGate, MERGE_GATE, ownerAtHeadRow, stepOf } from "./coordinator-evidence.js";

/**
 * TP-4763, owner decision 552: a seat runs `gate resolve --owner-ask` after the owner approved that exact command at a
 * Claude Code permissions.ask prompt. Nothing here can verify the approval, because the seat and the owner are the same
 * OS user, so the row says `owner-ask`, never `owner-terminal`, and only judgement gates take it.
 */
const OWNER_ASK = "owner-ask";

const CLI_CHANNEL = "factory-cli";
const DEVICE_RULE = "HW-CO";
const PUBLISH_TABLES: ReadonlySet<string> = new Set(["shepherd-release"]);
const PUBLISH_ROWS = /^authority\/REL-/;
/** The land policy tables whose gates are judgement calls; any other table, a new one included, stays with the owner. */
const JUDGEMENT_TABLES: ReadonlySet<string> = new Set(["shepherd-merge-guard", "shepherd-seat", "shepherd-route", "factory-default"]);

export const ownerAskResolver = (seat: string): GateResolver => ({ class: OWNER_ASK, id: seat, channel: CLI_CHANNEL });

export const ownerAskEvidence = (gateId: string, seat: string) => ({ kind: OWNER_ASK, gateId, seat, approval: "claude-code-permissions-ask" });

/**
 * Why `owner-ask` may not answer this gate, naming the rule that keeps it with the owner; undefined for an approve-merge
 * land gate whose policy table is a judgement table and whose rule is not publish, device or owner-presence.
 */
function ownerAskRefusal(gate: Pick<GateRecord, "id" | "prompt" | "schema">): string | undefined {
  const step = stepOf(gate.id);
  if (step.startsWith("device-")) return `device gate ${gate.id} keeps rule ${DEVICE_RULE}: only owner-terminal confirms a device step`;
  if (step !== MERGE_GATE) return `owner-ask answers only approve-merge gates; ${gate.id} is ${step}`;
  const land = landGate(gate);
  if (land === undefined) return `approve-merge gate ${gate.id} names no policy rule owner-ask can check`;
  const [table = ""] = land.rule.split("/");
  if (PUBLISH_TABLES.has(table) || PUBLISH_ROWS.test(land.rule)) return `publish rule ${land.rule} keeps ${gate.id} with the owner`;
  if (!JUDGEMENT_TABLES.has(table)) return `rule ${land.rule} is not a judgement table owner-ask may answer; ${gate.id} stays with the owner`;
  const presence = ownerAtHeadRow(gate);
  if (presence !== undefined) return `owner-presence rule ${presence} keeps ${gate.id} with the owner at the head`;
  return undefined;
}

/** Admits `owner-ask` only on its own evidence for this gate; `ownerAskAuthorize` then applies the rule check. */
export function withOwnerAsk(next: GateEvidencePolicy): GateEvidencePolicy {
  return (gate, resolver, payload, evidence) => {
    if (resolver.class !== OWNER_ASK) return next(gate, resolver, payload, evidence);
    return resolver.channel === CLI_CHANNEL && evidence.kind === OWNER_ASK && evidence.gateId === gate.id && evidence.seat === resolver.id;
  };
}

/** Refuses `owner-ask` with the rule named on any gate `ownerAskRefusal` keeps with the owner; every other class goes to `next`. */
export function ownerAskAuthorize(next: GateAuthorize): GateAuthorize {
  return (gate, resolver, admission) => {
    if (resolver.class !== OWNER_ASK) return next(gate, resolver, admission);
    const reason = ownerAskRefusal(gate);
    return reason === undefined ? next(gate, resolver, admission) : { allowed: false, reason };
  };
}
