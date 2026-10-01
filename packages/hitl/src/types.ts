import type { ActorClass, ResolverClass } from "@titan-design/authority";

/** A gate is a row, never a promise: pending work survives the process that opened it. */
export type GateStatus = "pending" | "resolved" | "cancelled" | "expired";

/** A JSON Schema document, stored so any process can validate a payload without the original zod schema. */
export type JsonSchema = Record<string, unknown>;

export interface GateRecord {
  id: string;
  prompt: string;
  schema: JsonSchema | undefined;
  status: GateStatus;
  payload: unknown;
  /** Why the gate was cancelled; unset for every other status. */
  reason: string | undefined;
  /** ISO-8601 with milliseconds, the shape store-sqlite writes and any surface can send as-is. */
  createdAt: string;
  resolvedAt: string | undefined;
  expiresAt: string | undefined;
  /** Who resolved the gate, as claimed by the caller; unset for gates resolved before stores recorded it. */
  resolvedBy: GateResolver | undefined;
  /** The authority rule that opened the gate; unset for a gate no rule governs. */
  rule: GateRule | undefined;
}

/** Binds a gate to the authority rule that opened it, so only that rule's resolver classes may answer. */
export interface GateRule {
  table: string;
  version: string;
  ruleId: string;
  resolvers: ResolverClass[];
}

/** A claim about who answered a gate. hitl records it and checks its class; it cannot prove it. */
export interface GateResolver {
  class: ActorClass;
  id: string;
  channel: string;
  /** The channel's own id for the confirming event, such as a chat reaction. */
  confirmEvent?: string;
}

export type GateAuthorization = { allowed: true } | { allowed: false; reason: string };

/**
 * Runs after the default resolver-class check, so it can refuse a resolver but
 * never admit one the default refused. Must return synchronously.
 */
export type GateAuthorize = (gate: Readonly<GateRecord>, resolver: Readonly<GateResolver>) => GateAuthorization;

export interface GateInput {
  /** Defaults to a random UUID. Supply one to make the gate addressable by a name you already own. */
  id?: string;
  prompt: string;
  schema?: JsonSchema;
  expiresAt?: Date | string;
  rule?: GateRule;
}

/**
 * Synchronous on purpose: both implementations are local (a Map, and
 * better-sqlite3), and `wait` is the only thing that needs to be async.
 */
export interface GateStore {
  create(input: GateInput): GateRecord;
  get(id: string): GateRecord | undefined;
  resolve(id: string, payload: unknown, resolvedBy: GateResolver): GateRecord;
  cancel(id: string, reason: string): GateRecord;
  listPending(): GateRecord[];
}

export class GateError extends Error {
  constructor(
    message: string,
    readonly gateId: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class GateNotFound extends GateError {
  constructor(gateId: string) {
    super(`no gate with id ${gateId}`, gateId);
  }
}

export class GateAlreadyExists extends GateError {
  constructor(gateId: string) {
    super(`a gate with id ${gateId} already exists`, gateId);
  }
}

export class GateAlreadySettled extends GateError {
  constructor(
    gateId: string,
    readonly status: GateStatus,
  ) {
    super(`gate ${gateId} is already ${status}`, gateId);
  }
}

export class GateCancelled extends GateError {
  constructor(
    gateId: string,
    readonly reason: string,
  ) {
    super(`gate ${gateId} was cancelled: ${reason}`, gateId);
  }
}

export class GateExpired extends GateError {
  constructor(gateId: string) {
    super(`gate ${gateId} expired before anyone resolved it`, gateId);
  }
}

export class GatePayloadInvalid extends GateError {
  constructor(
    gateId: string,
    readonly issues: string[],
  ) {
    super(`payload for gate ${gateId} does not match its schema: ${issues.join("; ")}`, gateId);
  }
}

export class GateAborted extends GateError {
  constructor(gateId: string, reason: string) {
    super(`stopped waiting on gate ${gateId}: ${reason}`, gateId);
  }
}

export class GateResolverRefused extends GateError {
  constructor(
    gateId: string,
    readonly actorClass: string | undefined,
    readonly reason: string,
  ) {
    super(`gate ${gateId} refused a resolution by ${actorClass ?? "an unnamed resolver"}: ${reason}`, gateId);
  }
}

/**
 * The store cannot record a resolver or a rule because its table predates the migration that adds the column.
 * `gateId` is empty when the store refuses at construction, before any gate is named.
 */
export class GateStoreSchemaOutdated extends GateError {
  constructor(
    gateId: string,
    readonly table: string,
    readonly migration: string,
  ) {
    const message =
      gateId === ""
        ? `cannot open a gate store on table ${table}: it needs ${migration}`
        : `gate ${gateId} cannot be recorded: table ${table} needs ${migration}`;
    super(message, gateId);
  }
}

export class GateRuleInvalid extends GateError {
  constructor(
    gateId: string,
    readonly reason: string,
  ) {
    super(`gate ${gateId} has an invalid rule: ${reason}`, gateId);
  }
}

export class GateAuthorizeInvalid extends GateError {
  constructor(gateId: string) {
    super(`authorize for gate ${gateId} must return a decision { allowed: boolean } synchronously`, gateId);
  }
}
