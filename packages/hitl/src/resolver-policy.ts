import {
  ACTOR_CLASSES,
  DELEGATE_RESOLVER_CLASSES,
  RESOLVER_CLASSES,
  type ActorClass,
  type DelegateResolverClass,
  type ResolverClass,
} from "@titan-design/authority";
import {
  GateAuthorizeInvalid,
  GateEvidenceInvalid,
  GateResolverRefused,
  GateRuleInvalid,
  type GateAnswerAllowance,
  type GateAuthorization,
  type GateEvidence,
  type GateEvidencePolicy,
  type GateRecord,
  type GateResolver,
  type GateRule,
} from "./types.js";

/**
 * The default refusal: only an owner class may resolve a gate, so an agent or
 * automation never answers its own gate. Every store applies it before `authorize`.
 */
export function defaultResolverRefusal(resolver: GateResolver): string | undefined {
  if ((RESOLVER_CLASSES as readonly string[]).includes(resolver.class)) return undefined;
  return `actor class ${resolver.class} may not resolve a gate`;
}

/** Reads each allowance once into a frozen deep copy, so a caller cannot widen the list after the store is built. */
export function snapshotAllowances(raw: readonly GateAnswerAllowance[] | undefined): readonly GateAnswerAllowance[] {
  return Object.freeze(
    (raw ?? []).map(({ resolverClass, stepId, payload }) =>
      Object.freeze({ resolverClass, stepId, payload: Object.freeze(structuredClone(payload)) }),
    ),
  );
}

/**
 * What may widen the default refusal for one resolve: the store's allowances, its evidence policy over the given
 * evidence, and a delegate the gate's rule names, which counts only when the store has `authorize` to run after it.
 */
export interface Admission {
  allowances: readonly GateAnswerAllowance[];
  evidence: Readonly<GateEvidence> | undefined;
  evidencePolicy: GateEvidencePolicy | undefined;
  hasAuthorize: boolean;
}

/**
 * Like `defaultResolverRefusal`, but a listed (class, step, payload) triple is admitted, and so is a resolve the
 * evidence policy admits on the evidence given, and a delegate class the gate's rule names. Anything else gets the
 * default refusal unchanged.
 */
export function resolverRefusal(gate: GateRecord, resolver: GateResolver, payload: unknown, admission: Admission): string | undefined {
  const refusal = defaultResolverRefusal(resolver);
  if (refusal === undefined) return undefined;
  const admitted =
    matchesAllowance(admission.allowances, gate.id, resolver, payload) ||
    evidenceAdmits(gate, resolver, payload, admission) ||
    delegateAdmits(gate.rule, resolver, admission.hasAuthorize);
  if (!admitted) return refusal;
  return resolver.id.trim() === "" ? `actor class ${resolver.class} must name itself to resolve this gate` : undefined;
}

/**
 * The class must be a delegate class as well as named by the rule, because a SQLite row's rule may have been written
 * by a raw INSERT that never passed `snapshotRule`. Without `authorize` no delegate is admitted at all.
 */
function delegateAdmits(rule: GateRule | undefined, resolver: GateResolver, hasAuthorize: boolean): boolean {
  if (!hasAuthorize || !isDelegateClass(resolver.class)) return false;
  const delegates: unknown = rule?.delegates;
  return Array.isArray(delegates) && (delegates as readonly unknown[]).includes(resolver.class);
}

/** A policy that throws or answers anything but `true` admits nothing, so a bug in it fails closed. */
function evidenceAdmits(gate: GateRecord, resolver: GateResolver, payload: unknown, { evidence, evidencePolicy }: Admission): boolean {
  if (evidence === undefined || evidencePolicy === undefined) return false;
  try {
    return evidencePolicy(Object.freeze({ ...gate }), resolver, payload, evidence) === true;
  } catch {
    return false;
  }
}

const MAX_EVIDENCE_BYTES = 16_384;

/** A frozen JSON copy, so the policy and the stored row see the same facts and a caller cannot change them after the check. */
export function snapshotEvidence(gateId: string, raw: unknown): Readonly<GateEvidence> {
  const text = serialized(gateId, raw);
  const copy: unknown = JSON.parse(text);
  if (typeof copy !== "object" || copy === null || Array.isArray(copy)) throw new GateEvidenceInvalid(gateId, "it is not a JSON object");
  if (text.length > MAX_EVIDENCE_BYTES) throw new GateEvidenceInvalid(gateId, `it is over ${MAX_EVIDENCE_BYTES} characters`);
  return deepFreeze(copy as GateEvidence);
}

function serialized(gateId: string, raw: unknown): string {
  try {
    const text = JSON.stringify(raw) as string | undefined;
    if (text !== undefined) return text;
  } catch {
    // A cycle or a BigInt lands here; either way the evidence cannot be stored.
  }
  throw new GateEvidenceInvalid(gateId, "it does not serialize as JSON");
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

/** True when an allowance names this resolver's class, the gate's step and exactly this payload. The store and its callers share this test. */
export function matchesAllowance(allowances: readonly GateAnswerAllowance[], gateId: string, resolver: GateResolver, payload: unknown): boolean {
  return allowances.some((a) => a.resolverClass === resolver.class && stepOf(gateId) === a.stepId && jsonEqual(payload, a.payload));
}

/** Deep equality over plain JSON data (objects, arrays, primitives); anything else, such as a class instance, is unequal. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const proto = Object.getPrototypeOf(a) as unknown;
  if (proto !== Object.getPrototypeOf(b) || (proto !== Object.prototype && proto !== Array.prototype && proto !== null)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** The step id of a gate id: the text after the last `/`, without a repeat suffix `:<n>`. */
function stepOf(gateId: string): string {
  return gateId.slice(gateId.lastIndexOf("/") + 1).replace(/:\d+$/, "");
}

/**
 * A rule-bound gate admits only its rule's resolver classes, and its delegates when the store has `authorize`.
 * Runs after the default refusal, so it only narrows.
 */
export function ruleResolverRefusal(record: GateRecord, resolver: GateResolver, hasAuthorize = false): string | undefined {
  if (!record.rule) return undefined;
  if ((record.rule.resolvers as readonly string[]).includes(resolver.class)) return undefined;
  if (delegateAdmits(record.rule, resolver, hasAuthorize)) return undefined;
  return `rule ${record.rule.ruleId} does not let ${resolver.class} resolve this gate`;
}

/** Reads each declared rule field once into a frozen copy, so a caller cannot widen the rule after `create`. */
export function snapshotRule(gateId: string, raw: unknown): Readonly<GateRule> {
  if (typeof raw !== "object" || raw === null) throw new GateRuleInvalid(gateId, "the rule is not an object");
  const { table, version, ruleId, resolvers, delegates } = raw as Record<string, unknown>;
  if (typeof table !== "string" || typeof version !== "string" || typeof ruleId !== "string") {
    throw new GateRuleInvalid(gateId, "the rule's table, version and ruleId must be strings");
  }
  const classes = Array.isArray(resolvers) ? [...(resolvers as unknown[])] : [];
  if (classes.length === 0 || !classes.every(isResolverClass)) {
    throw new GateRuleInvalid(gateId, "the rule's resolvers must be a non-empty list of resolver classes");
  }
  const rule = { table, version, ruleId, resolvers: Object.freeze(classes) as ResolverClass[] };
  if (delegates === undefined) return Object.freeze(rule);
  return Object.freeze({ ...rule, delegates: snapshotDelegates(gateId, delegates) });
}

function snapshotDelegates(gateId: string, raw: unknown): DelegateResolverClass[] {
  const classes = Array.isArray(raw) ? [...(raw as unknown[])] : [];
  if (classes.length === 0 || !classes.every(isDelegateClass)) {
    throw new GateRuleInvalid(gateId, `the rule's delegates must be a non-empty list drawn from ${DELEGATE_RESOLVER_CLASSES.join(", ")}`);
  }
  return Object.freeze(classes) as DelegateResolverClass[];
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

function isResolverClass(value: unknown): value is ResolverClass {
  return typeof value === "string" && (RESOLVER_CLASSES as readonly string[]).includes(value);
}

function isDelegateClass(value: unknown): value is DelegateResolverClass {
  return typeof value === "string" && (DELEGATE_RESOLVER_CLASSES as readonly string[]).includes(value);
}

function isActorClass(value: unknown): value is ActorClass {
  return typeof value === "string" && (ACTOR_CLASSES as readonly string[]).includes(value);
}
