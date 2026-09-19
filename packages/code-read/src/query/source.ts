import { EXIT } from "@titan-design/rpc-protocol";
import type { CommandName } from "./contract.js";
import type { ReadModel } from "./model.js";
import type { Capabilities, RuleSummary, SnapshotInfo } from "./schemas.js";

/** What a source can serve, independent of any one snapshot. */
export interface SourceFacts {
  dataset: "live" | "static";
  commands: readonly CommandName[];
  capabilities: Capabilities;
  rules: readonly RuleSummary[];
}

/**
 * The seam every query function reads through. The daemon implements it over SQLite with an
 * LRU of models; a static export implements it over a decoded dataset. Same queries, same answers.
 */
export interface ReadSource {
  facts(): SourceFacts;
  /** Every snapshot, newest first. */
  snapshots(): readonly SnapshotInfo[];
  /** Throws a `ReadError` with `EXIT.NOINPUT` when the snapshot does not exist. */
  model(snapshotId: number): ReadModel;
}

/** A failure carrying the sysexits code every surface reports, so the registry's `describeError` maps it as is. */
export class ReadError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "ReadError";
  }
}

export function snapshotNotFound(snapshotId: number): ReadError {
  return new ReadError(`No snapshot with id ${snapshotId}`, EXIT.NOINPUT);
}

export function nodeNotFound(id: string, snapshotId: number): ReadError {
  return new ReadError(`No node "${id}" in snapshot ${snapshotId}`, EXIT.NOINPUT);
}

/** Bad arguments the schema cannot express, such as "exactly one of"; same code as a schema failure. */
export function invalidArgs(message: string): ReadError {
  return new ReadError(`Invalid arguments: ${message}`, EXIT.DATAERR);
}
