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
}

export interface GateInput {
  /** Defaults to a random UUID. Supply one to make the gate addressable by a name you already own. */
  id?: string;
  prompt: string;
  schema?: JsonSchema;
  expiresAt?: Date | string;
}

/**
 * Synchronous on purpose: both implementations are local (a Map, and
 * better-sqlite3), and `wait` is the only thing that needs to be async.
 */
export interface GateStore {
  create(input: GateInput): GateRecord;
  get(id: string): GateRecord | undefined;
  resolve(id: string, payload: unknown): GateRecord;
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
