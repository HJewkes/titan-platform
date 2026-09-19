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

/** Where excerpt text came from: the snapshot's commit, a working tree proven to match it, or a static export. */
export type SourceOrigin = "commit" | "worktree" | "export";

/** Some or all of one file's lines as they were at the snapshot; `startLine` is the first line held. */
export interface SourceWindow {
  path: string;
  contentHash: string;
  origin: SourceOrigin;
  startLine: number;
  lines: readonly string[];
  /** Lines in the whole file, so a window can be clipped at the file's end. */
  lineCount: number;
}

/** Open string: "no-source" | "changed-since-snapshot" | "not-in-export" | "unreadable" today. */
export type SourceRead = SourceWindow | { unavailable: string };

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
  /** A file's text at the snapshot; absent when the source holds no source text at all. */
  readSource?(snapshotId: number, path: string): SourceRead;
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

export function findingNotFound(id: string, snapshotId: number): ReadError {
  return new ReadError(`No finding "${id}" in snapshot ${snapshotId}`, EXIT.NOINPUT);
}

/** Bad arguments the schema cannot express, such as "exactly one of"; same code as a schema failure. */
export function invalidArgs(message: string): ReadError {
  return new ReadError(`Invalid arguments: ${message}`, EXIT.DATAERR);
}
