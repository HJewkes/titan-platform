import { ACTOR_CLASSES, RESOLVER_CLASSES, type ActorClass } from "@titan-design/authority";
import { GateAuthorizeInvalid, GateResolverRefused, type GateAuthorization, type GateResolver } from "./types.js";

/**
 * The default refusal: only an owner class may resolve a gate, so an agent or
 * automation never answers its own gate. Every store applies it before `authorize`.
 */
export function defaultResolverRefusal(resolver: GateResolver): string | undefined {
  if ((RESOLVER_CLASSES as readonly string[]).includes(resolver.class)) return undefined;
  return `actor class ${resolver.class} may not resolve a gate`;
}

/**
 * Reads each declared field exactly once into a frozen plain object, so the
 * checks and the stored row see the same resolver and nothing undeclared is kept.
 */
export function snapshotResolver(gateId: string, raw: unknown): Readonly<GateResolver> {
  if (typeof raw !== "object" || raw === null) throw new GateResolverRefused(gateId, undefined, "the resolver is not an object");
  const { class: actorClass, id, channel, confirmEvent } = raw as Record<string, unknown>;
  if (!isActorClass(actorClass)) {
    throw new GateResolverRefused(gateId, undefined, "the resolver's class is not a known actor class");
  }
  if (typeof id !== "string" || typeof channel !== "string") {
    throw new GateResolverRefused(gateId, actorClass, "the resolver's id and channel must be strings");
  }
  if (confirmEvent === undefined) return Object.freeze({ class: actorClass, id, channel });
  if (typeof confirmEvent !== "string") {
    throw new GateResolverRefused(gateId, actorClass, "the resolver's confirmEvent must be a string");
  }
  return Object.freeze({ class: actorClass, id, channel, confirmEvent });
}

/** Accepts only a synchronous `{ allowed: boolean }`; a promise is refused because the row cannot wait on it. */
export function readDecision(gateId: string, decision: unknown): GateAuthorization {
  if (typeof decision !== "object" || decision === null) throw new GateAuthorizeInvalid(gateId);
  const { then, allowed, reason } = decision as Record<string, unknown>;
  if (typeof then === "function") {
    (then as (onFulfilled: undefined, onRejected: () => void) => unknown).call(decision, undefined, () => {});
    throw new GateAuthorizeInvalid(gateId);
  }
  if (typeof allowed !== "boolean") throw new GateAuthorizeInvalid(gateId);
  if (allowed) return { allowed: true };
  return { allowed: false, reason: typeof reason === "string" ? reason : "authorize refused the resolver" };
}

function isActorClass(value: unknown): value is ActorClass {
  return typeof value === "string" && (ACTOR_CLASSES as readonly string[]).includes(value);
}
