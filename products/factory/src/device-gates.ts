import { canResolve, DEFAULT_TABLE } from "@titan-design/authority";
import type { GateAdmission, GateAuthorize, GateAuthorization, GateRecord, GateResolver } from "@titan-design/hitl";
import { stepOf } from "./coordinator-evidence.js";

/** A device gate's step id, with any `:<n>` repeat suffix already stripped by `stepOf`. */
const DEVICE_GATE = /^device-/;

/** The table row that names who may confirm a device step; automation, the factory's own class, is denied it (HW-AU). */
const DEVICE_RULE = "HW-CO";

/** The `gate resolve` CLI on the factory's own machine. A signed proof arrives over `factory-proof` from elsewhere. */
const TERMINAL_CHANNEL = "factory-cli";

const ALLOWED: GateAuthorization = Object.freeze({ allowed: true });

/**
 * The factory store's `authorize`. A device gate takes only the classes `DEVICE_RULE` names, and only from the terminal
 * at the device, so the owner who performed the step is the one who confirms it. On every other gate a rule delegate
 * answers only when the evidence policy or an allowance admitted it: having `authorize` at all switches on rule
 * delegates in hitl, and a delegate the rule alone names would otherwise answer with nothing behind it.
 */
export const deviceGateAuthorize: GateAuthorize = (gate, resolver, admission) =>
  DEVICE_GATE.test(stepOf(gate.id)) ? deviceRefusal(gate, resolver) : delegateRefusal(gate, resolver, admission);

function deviceRefusal(gate: Readonly<GateRecord>, resolver: Readonly<GateResolver>): GateAuthorization {
  if (!canResolve(DEFAULT_TABLE, DEVICE_RULE, { class: resolver.class, tainted: false })) {
    return { allowed: false, reason: `device gate ${gate.id} answers only to owner-terminal (${DEVICE_RULE}), not ${resolver.class}` };
  }
  if (resolver.channel !== TERMINAL_CHANNEL) {
    return { allowed: false, reason: `device gate ${gate.id} answers only through ${TERMINAL_CHANNEL}, not ${resolver.channel}` };
  }
  return ALLOWED;
}

function delegateRefusal(gate: Readonly<GateRecord>, resolver: Readonly<GateResolver>, admission: Readonly<GateAdmission> | undefined): GateAuthorization {
  const delegates: readonly string[] = gate.rule?.delegates ?? [];
  if (!delegates.includes(resolver.class)) return ALLOWED;
  if (admission !== undefined && admission.admittedBy !== "delegate") return ALLOWED;
  return { allowed: false, reason: `factory gates admit a rule delegate only on evidence or an allowance; ${resolver.class} has neither on ${gate.id}` };
}
