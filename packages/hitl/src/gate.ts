import { toJSONSchema, type ZodType } from "zod";
import {
  GateAborted,
  GateCancelled,
  GateExpired,
  GateNotFound,
  GatePayloadInvalid,
  type GateRecord,
  type GateStore,
} from "./types.js";

export const DEFAULT_POLL_MS = 250;

export interface OpenGateOptions<T> {
  id?: string;
  prompt: string;
  /** Stored as JSON Schema so the resolving process can validate without it, and reused here to type the answer. */
  schema?: ZodType<T>;
  expiresAt?: Date | string;
}

export interface WaitOptions<T> {
  pollMs?: number;
  signal?: AbortSignal;
  /** Needed only when re-attaching to a gate this process did not open. */
  schema?: ZodType<T>;
}

export interface GateHandle<T> {
  id: string;
  record: GateRecord;
  wait(options?: Omit<WaitOptions<T>, "schema">): Promise<T>;
}

/**
 * Open a gate and hand back something to await. The row exists before this
 * returns, so a crash here leaves a resolvable gate rather than a lost one.
 */
export function openGate<T = unknown>(store: GateStore, options: OpenGateOptions<T>): GateHandle<T> {
  const input: Parameters<GateStore["create"]>[0] = { prompt: options.prompt };
  if (options.id !== undefined) input.id = options.id;
  if (options.expiresAt !== undefined) input.expiresAt = options.expiresAt;
  if (options.schema) input.schema = toJSONSchema(options.schema) as Record<string, unknown>;

  const record = store.create(input);
  return {
    id: record.id,
    record,
    wait: (waitOptions = {}) => {
      const merged: WaitOptions<T> = { ...waitOptions };
      if (options.schema) merged.schema = options.schema;
      return waitForGate<T>(store, record.id, merged);
    },
  };
}

/**
 * Await a gate by id from any process, including one that restarted after the
 * gate was opened. Polls rather than subscribes because the resolver may be a
 * different process writing the same SQLite file.
 */
export async function waitForGate<T = unknown>(
  store: GateStore,
  id: string,
  options: WaitOptions<T> = {},
): Promise<T> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    throwIfAborted(id, options.signal);
    const record = store.get(id);
    if (!record) throw new GateNotFound(id);
    if (record.status === "resolved") return validate(record, options.schema);
    if (record.status === "cancelled") throw new GateCancelled(id, record.reason ?? "no reason given");
    if (record.status === "expired") throw new GateExpired(id);
    await sleep(pollMs, options.signal);
  }
}

/** Resolve a gate from wherever the human answered: a CLI, an MCP tool, a dashboard route. */
export function resolveGate(store: GateStore, id: string, payload: unknown): GateRecord {
  return store.resolve(id, payload);
}

export function cancelGate(store: GateStore, id: string, reason: string): GateRecord {
  return store.cancel(id, reason);
}

function validate<T>(record: GateRecord, schema: ZodType<T> | undefined): T {
  if (!schema) return record.payload as T;
  const parsed = schema.safeParse(record.payload);
  if (parsed.success) return parsed.data;
  throw new GatePayloadInvalid(
    record.id,
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`),
  );
}

function throwIfAborted(id: string, signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GateAborted(id, String(signal.reason ?? "aborted"));
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}
