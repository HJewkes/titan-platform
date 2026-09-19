import { EXIT } from "@titan-design/rpc-protocol";
import type { ReadModel } from "./model.js";
import type { SnapshotInfo, SnapshotRef } from "./schemas.js";
import { ReadError, snapshotNotFound, type ReadSource } from "./source.js";

const DIGITS = /^\d+$/;

/** An id, a digit string, or a ref name (its newest snapshot); omitted means the newest overall. */
export function resolveSnapshot(source: ReadSource, ref: SnapshotRef | undefined): SnapshotInfo {
  const snapshots = source.snapshots();
  if (ref === undefined) {
    const newest = snapshots[0];
    if (!newest) throw new ReadError("No snapshots have been indexed", EXIT.NOINPUT);
    return newest;
  }
  if (typeof ref === "number" || DIGITS.test(ref)) {
    const id = Number(ref);
    const found = snapshots.find((s) => s.id === id);
    if (!found) throw snapshotNotFound(id);
    return found;
  }
  const newestOfRef = snapshots.find((s) => s.ref === ref);
  if (!newestOfRef) throw new ReadError(`No snapshot of ref "${ref}"`, EXIT.NOINPUT);
  return newestOfRef;
}

export function modelFor(source: ReadSource, ref: SnapshotRef | undefined): ReadModel {
  return source.model(resolveSnapshot(source, ref).id);
}
