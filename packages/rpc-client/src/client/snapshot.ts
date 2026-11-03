import type { JsonEnvelope } from "@titan-design/rpc-protocol";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import { snapshotKey, wireArgs } from "./canonical-key.js";
import type { DataSource } from "./data-source.js";
import { isEnvelope } from "./envelope-shape.js";

export const SNAPSHOT_FORMAT = "titan-snapshot@1";

/**
 * One JSON file that answers calls without a server: recorded envelopes keyed by
 * `snapshotKey(command, args)`, and an optional dataset that a resolver answers from.
 */
export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT;
  /** ISO 8601 time the snapshot was taken, so a reader can say how old the data is. */
  createdAt: string;
  calls: Record<string, JsonEnvelope<unknown>>;
  /** Opaque here; its shape belongs to whichever package supplies the resolver. */
  dataset?: unknown;
}

/**
 * Answers a call from a snapshot's dataset. `args` arrive raw and unvalidated, so the
 * resolver validates them the way the daemon would. Never throws: an unknown or
 * live-only command is `EXIT.UNAVAILABLE`, bad args are `EXIT.DATAERR`.
 */
export type SnapshotResolver<D = unknown> = (
  command: string,
  args: unknown,
  dataset: D,
) => JsonEnvelope<unknown> | Promise<JsonEnvelope<unknown>>;

export interface SnapshotPlan {
  /** Calls to record, each answered once by the source. */
  calls?: ReadonlyArray<{ command: string; args?: unknown }>;
  dataset?: unknown;
  /** Defaults to now. */
  createdAt?: Date;
}

/** Records every planned call's envelope, failures included, so a replay fails the same way. */
export async function buildSnapshot(source: Pick<DataSource, "call">, plan: SnapshotPlan): Promise<Snapshot> {
  const calls: Record<string, JsonEnvelope<unknown>> = {};
  for (const { command, args } of plan.calls ?? []) {
    calls[snapshotKey(command, args)] = await source.call(command, wireArgs(args));
  }
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: (plan.createdAt ?? new Date()).toISOString(), calls };
  if (plan.dataset !== undefined) snapshot.dataset = plan.dataset;
  return snapshot;
}

/** Checks a parsed file is a `titan-snapshot@1`; throws naming the first thing wrong. */
export function parseSnapshot(value: unknown): Snapshot {
  if (!isObjectLike(value)) throw new Error("Snapshot must be a JSON object");
  if (value.format !== SNAPSHOT_FORMAT) {
    throw new Error(`Unsupported snapshot format ${JSON.stringify(value.format)}; expected ${SNAPSHOT_FORMAT}`);
  }
  const { createdAt, calls } = value;
  if (typeof createdAt !== "string") throw new Error("Snapshot createdAt must be a string");
  if (!isObjectLike(calls) || Array.isArray(calls)) throw new Error("Snapshot calls must be an object");
  // Unknown top-level keys are kept so a field a newer writer adds still reaches the reader.
  return { ...value, format: SNAPSHOT_FORMAT, createdAt, calls: parseCalls(calls) };
}

function parseCalls(calls: Record<string, unknown>): Record<string, JsonEnvelope<unknown>> {
  const entries: Array<[string, JsonEnvelope<unknown>]> = [];
  for (const [key, envelope] of Object.entries(calls)) {
    if (!isEnvelope(envelope)) throw new Error(`Snapshot call ${key} is not an envelope`);
    entries.push([key, envelope]);
  }
  // fromEntries defines own properties, so a "__proto__" key stays data instead of a prototype.
  return Object.fromEntries(entries);
}
