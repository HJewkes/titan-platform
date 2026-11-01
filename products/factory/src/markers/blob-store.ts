import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@titan-design/store-sqlite";
import { INLINE_LIMIT_BYTES } from "./marker-table.js";

/** The `refuse` hook of the workflow runtime's capability vault, which throws `CapabilityLeakError` for a value holding a secret. */
export interface CapabilityGuard {
  refuse(value: unknown, where: string): void;
}

/**
 * Where large blobs go, and the guard every write passes. `blobDir` is `<db dir>/marker-blobs`.
 * A store with no guard refuses every write, so a missing capability can never let a secret through.
 */
export interface BlobStore {
  blobDir: string;
  capabilities?: CapabilityGuard;
}

/** A blob whose file (if any) is already on disk, ready for its row. */
export interface StagedBlob {
  digest: string;
  bytes: number;
  inline: Buffer | null;
  path: string | null;
}

const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Refuses a value that holds a capability secret; called before any blob byte is written. */
export function refuseSecrets(store: BlobStore, bytes: Uint8Array, where: string): void {
  if (!store.capabilities) throw new Error(`${where}: refused, the store has no capability guard`);
  store.capabilities.refuse(Buffer.from(bytes).toString("utf8"), where);
}

/**
 * The file name comes from the digest alone, so no caller-supplied text reaches the filesystem.
 * The write is a temp file and a rename, so a reader never sees a partial blob.
 */
export function stageBlob(store: BlobStore, bytes: Uint8Array): StagedBlob {
  const digest = digestOf(bytes);
  if (bytes.byteLength <= INLINE_LIMIT_BYTES) return { digest, bytes: bytes.byteLength, inline: Buffer.from(bytes), path: null };
  const name = digest.slice("sha256:".length);
  mkdirSync(store.blobDir, { recursive: true });
  const temp = join(store.blobDir, `${name}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temp, bytes);
  renameSync(temp, join(store.blobDir, name));
  return { digest, bytes: bytes.byteLength, inline: null, path: name };
}

/** Inserts the row for a staged blob; a digest already stored is left as it is, so equal content is stored once. */
export function insertBlobRow(db: Db, blob: StagedBlob, createdAt: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO factory_marker_blob (digest, bytes, inline, path, created_at) VALUES (@digest, @bytes, @inline, @path, @createdAt)",
  ).run({ ...blob, createdAt });
}

export function putBlob(db: Db, store: BlobStore, bytes: Uint8Array, createdAt: string): string {
  refuseSecrets(store, bytes, "marker blob");
  const staged = stageBlob(store, bytes);
  db.transaction(() => insertBlobRow(db, staged, createdAt)).immediate();
  return staged.digest;
}

interface BlobRow {
  inline: Buffer | null;
  path: string | null;
}

/** The stored bytes, or undefined when the row, the file, or the content's digest is gone: a missing blob is not an error. */
export function getBlob(db: Db, store: BlobStore, digest: string): Buffer | undefined {
  const match = DIGEST_PATTERN.exec(digest);
  if (!match) return undefined;
  const row = db.prepare<[string], BlobRow>("SELECT inline, path FROM factory_marker_blob WHERE digest = ?").get(digest);
  if (!row) return undefined;
  const bytes = row.inline ?? readBlobFile(store, match[1]!);
  return bytes && digestOf(bytes) === digest ? bytes : undefined;
}

function readBlobFile(store: BlobStore, name: string): Buffer | undefined {
  try {
    return readFileSync(join(store.blobDir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
