import { failureOf } from "./error-class.js";

/** A live agent that took neither the wake nor its message fallback, retired so a successor can take the wake. */
export interface Hung {
  kind: "hung";
  agent: string;
}

type Retirer = { retire?(name: string): Promise<void> };

/**
 * A live headless agent can sit idle through both asks (tp#2648, tp#2663), so it is retired and a successor takes the
 * wake. The retire is never forced, so a tree with unpushed work keeps its agent; and an agent no successor could
 * replace, on an advisory repo or one with no checkout, is left running. Either way the seat is told, as before.
 */
export async function retireHung(agents: Retirer, agent: string, replaceable: boolean, stalled: string, signal: AbortSignal): Promise<Hung | { kind: "unhandled"; reason: string }> {
  if (agents.retire === undefined || !replaceable) return { kind: "unhandled", reason: stalled };
  try {
    await agents.retire(agent);
    return { kind: "hung", agent };
  } catch (error) {
    signal.throwIfAborted();
    return { kind: "unhandled", reason: `${stalled}, and its retire failed: ${failureOf(error)}` };
  }
}
