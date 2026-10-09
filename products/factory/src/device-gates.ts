import { canResolve, DEFAULT_TABLE } from "@titan-design/authority";
import type { GateAuthorize, GateAuthorization, GateRecord, GateResolver } from "@titan-design/hitl";
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
 * at the device, so the owner who performed the step is the one who confirms it. Every other gate keeps the store's
 * prior behaviour: having `authorize` at all switches on rule delegates in hitl, and the factory admits none.
 */
export const deviceGateAuthorize: GateAuthorize = (gate, resolver) =>
  DEVICE_GATE.test(stepOf(gate.id)) ? deviceRefusal(gate, resolver) : delegateRefusal(gate, resolver);

function deviceRefusal(gate: Readonly<GateRecord>, resolver: Readonly<GateResolver>): GateAuthorization {
  if (!canResolve(DEFAULT_TABLE, DEVICE_RULE, { class: resolver.class, tainted: false })) {
    return { allowed: false, reason: `device gate ${gate.id} answers only to owner-terminal (${DEVICE_RULE}), not ${resolver.class}` };
  }
  if (resolver.channel !== TERMINAL_CHANNEL) {
    return { allowed: false, reason: `device gate ${gate.id} answers only through ${TERMINAL_CHANNEL}, not ${resolver.channel}` };
  }
  return ALLOWED;
}

function delegateRefusal(gate: Readonly<GateRecord>, resolver: Readonly<GateResolver>): GateAuthorization {
  const delegates: readonly string[] = gate.rule?.delegates ?? [];
  if (!delegates.includes(resolver.class)) return ALLOWED;
  return { allowed: false, reason: `factory gates admit no rule delegate; ${resolver.class} is one on ${gate.id}` };
}
