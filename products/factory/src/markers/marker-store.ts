import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import type { PinClass } from "../registry/pin-classes.js";
import { asText, getBlob, insertBlobRow, refuseSecrets, stageBlob, type BlobStore, type StagedBlob } from "./blob-store.js";

interface MarkerIdentity {
  item: string;
  fact: string;
  pinClass: PinClass;
  pin: string;
}

/**
 * What a dependent recorded about one material input. `output` is the input's full output digest, absent on rows written
 * before drift was tracked; validity treats a missing `output` as unknown, never as drift.
 */
export interface InputDigest {
  pin: string;
  projection: string;
  output?: string;
}

/** There is deliberately no field for an Unavailable outcome: such a step writes no marker. */
export interface MarkerInput extends MarkerIdentity {
  pinSeq?: number;
  expiresAt?: string;
  step: string;
  callSite: string;
  version: string;
  inputDigests: Record<string, InputDigest>;
  reads: { name: string; bytes: Uint8Array }[];
  output?: Uint8Array;
  projectionDigest?: string;
  runId?: string;
  memoKey?: string;
  reverted?: boolean;
  writtenAt: string;
}

interface MarkerRead {
  name: string;
  digest: string;
  bytes: number;
}

export interface MarkerRow extends MarkerIdentity {
  id: number;
  pinSeq: number | null;
  expiresAt: string | null;
  step: string;
  callSite: string;
  version: string;
  inputDigests: Record<string, InputDigest>;
  reads: MarkerRead[];
  outputDigest: string | null;
  projectionDigest: string | null;
  runId: string | null;
  memoKey: string | null;
  reverted: boolean;
  writtenAt: string;
}

/** The values whose blobs survive, beside the names of those that are gone; `missing` is empty for a complete marker. */
type MarkerValues = { reads: Map<string, Buffer>; output?: Buffer; missing: string[] };

/**
 * Appends one marker. The whole input passes the capability guard first, since the table is append-only and a stored
 * secret could never be scrubbed. Large values reach their files before the transaction opens (a failed write leaves only
 * an orphan file), and the blob rows and the marker commit together.
 */
export function writeMarker(db: Db, store: BlobStore, input: MarkerInput): { id: number } {
  refuseSecrets(store, guardView(input), "marker write");
  const staged = input.reads.map((read) => stageBlob(store, read.bytes));
  const output = input.output ? stageBlob(store, input.output) : undefined;
  const reads: MarkerRead[] = input.reads.map((read, i) => ({ name: read.name, digest: staged[i]!.digest, bytes: staged[i]!.bytes }));
  const blobs: StagedBlob[] = output ? [...staged, output] : staged;
  return db
    .transaction(() => {
      for (const blob of blobs) insertBlobRow(db, blob, input.writtenAt);
      return { id: insertMarker(db, input, reads, output?.digest) };
    })
    .immediate();
}

function guardView(input: MarkerInput): unknown {
  return {
    ...input,
    reads: input.reads.map((read) => ({ name: read.name, value: asText(read.bytes) })),
    output: input.output && asText(input.output),
  };
}

function insertMarker(db: Db, input: MarkerInput, reads: MarkerRead[], outputDigest: string | undefined): number {
  const result = db
    .prepare(
      `INSERT INTO factory_marker (item, fact, pin_class, pin, pin_seq, expires_at, step, call_site, version, input_digests, reads,
         output_digest, projection_digest, run_id, memo_key, reverted, written_at)
       VALUES (@item, @fact, @pinClass, @pin, @pinSeq, @expiresAt, @step, @callSite, @version, @inputDigests, @reads,
         @outputDigest, @projectionDigest, @runId, @memoKey, @reverted, @writtenAt)`,
    )
    .run({
      ...input,
      pinSeq: input.pinSeq ?? null,
      expiresAt: input.expiresAt ?? null,
      inputDigests: JSON.stringify(input.inputDigests),
      reads: JSON.stringify(reads),
      outputDigest: outputDigest ?? null,
      projectionDigest: input.projectionDigest ?? null,
      runId: input.runId ?? null,
      memoKey: input.memoKey ?? null,
      reverted: input.reverted ? 1 : 0,
    });
  return Number(result.lastInsertRowid);
}

interface StoredMarker {
  id: number;
  item: string;
  fact: string;
  pin_class: PinClass;
  pin: string;
  pin_seq: number | null;
  expires_at: string | null;
  step: string;
  call_site: string;
  version: string;
  input_digests: string;
  reads: string;
  output_digest: string | null;
  projection_digest: string | null;
  run_id: string | null;
  memo_key: string | null;
  reverted: number;
  written_at: string;
}

const inputDigestsSchema = z.record(z.string(), z.object({ pin: z.string(), projection: z.string(), output: z.string().optional() }));
const readsSchema = z.array(z.object({ name: z.string(), digest: z.string(), bytes: z.number() }));

function toRow(r: StoredMarker): MarkerRow {
  return {
    id: r.id,
    item: r.item,
    fact: r.fact,
    pinClass: r.pin_class,
    pin: r.pin,
    pinSeq: r.pin_seq,
    expiresAt: r.expires_at,
    step: r.step,
    callSite: r.call_site,
    version: r.version,
    inputDigests: inputDigestsSchema.parse(JSON.parse(r.input_digests)),
    reads: readsSchema.parse(JSON.parse(r.reads)),
    outputDigest: r.output_digest,
    projectionDigest: r.projection_digest,
    runId: r.run_id,
    memoKey: r.memo_key,
    reverted: r.reverted === 1,
    writtenAt: r.written_at,
  };
}

/** The newest row at an identity: the highest id wins. */
export function currentMarker(db: Db, identity: MarkerIdentity): MarkerRow | undefined {
  const row = db
    .prepare<Record<string, string>, StoredMarker>(
      "SELECT * FROM factory_marker WHERE item = @item AND fact = @fact AND pin_class = @pinClass AND pin = @pin ORDER BY id DESC LIMIT 1",
    )
    .get({ ...identity });
  return row && toRow(row);
}

/** Every row of an item's fact, superseded ones included, oldest first. */
export function markerHistory(db: Db, key: { item: string; fact: string }): MarkerRow[] {
  return db
    .prepare<[string, string], StoredMarker>("SELECT * FROM factory_marker WHERE item = ? AND fact = ? ORDER BY id")
    .all(key.item, key.fact)
    .map(toRow);
}

/** The recorded read values and output of a marker that survive, and the names of those whose blobs are gone. */
export function readMarkerValues(db: Db, store: BlobStore, id: number): MarkerValues {
  const row = db.prepare<[number], StoredMarker>("SELECT * FROM factory_marker WHERE id = ?").get(id);
  if (!row) return { reads: new Map(), missing: [`marker ${id}`] };
  const marker = toRow(row);
  const reads = new Map<string, Buffer>();
  const missing: string[] = [];
  for (const read of marker.reads) {
    const bytes = getBlob(db, store, read.digest);
    if (bytes) reads.set(read.name, bytes);
    else missing.push(read.name);
  }
  const output = marker.outputDigest ? getBlob(db, store, marker.outputDigest) : undefined;
  if (marker.outputDigest && !output) missing.push("output");
  return output ? { reads, output, missing } : { reads, missing };
}

/**
 * The current marker per identity of `step` that was written under another version than `version`: what a bump leaves
 * behind. Superseded rows are not listed, since a newer row at the same identity already answers for them.
 */
export function markersBehindVersion(db: Db, step: string, version: string): { item: string; fact: string; id: number }[] {
  return db
    .prepare<[string, string], { item: string; fact: string; id: number }>(
      `SELECT m.item, m.fact, m.id FROM factory_marker m
       WHERE m.step = ? AND m.version <> ?
         AND m.id = (SELECT MAX(n.id) FROM factory_marker n WHERE n.item = m.item AND n.fact = m.fact AND n.pin_class = m.pin_class AND n.pin = m.pin)
       ORDER BY m.id`,
    )
    .all(step, version);
}
