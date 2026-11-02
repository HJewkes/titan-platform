import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { appendEvent, eventLogMigration } from "../event-log/event-log.js";
import { advanceEpoch, headEpochMigration } from "../head-guard/epoch-store.js";
import { defineStep, type FactEntry } from "../registry/entry.js";
import { createRegistry } from "../registry/registry.js";
import type { BlobStore } from "./blob-store.js";
import { jcs } from "./jcs.js";
import { currentMarker, readMarkerValues, writeMarker, type InputDigest } from "./marker-store.js";
import { markerTableMigration } from "./marker-table.js";
import { outputDigest, projectionDigest } from "./projection.js";
import { evaluateFact, versionOf, type ValidityContext } from "./validity.js";

const ITEM = { repo: "O/R", pr: 7 };
const KEY = "o/r#7";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const AT = "2026-11-01T12:00:00.000Z";
const MERGEABILITY = "o/r#7|BaseChanged,HeadPushed,MainMoved";

let dir: string;
let db: Db;
let store: BlobStore;
let diff: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "validity-"));
  db = openDatabase(join(dir, "factory.db"));
  runMigrations(db, [markerTableMigration(), eventLogMigration(30), headEpochMigration(34)]);
  store = { blobDir: join(dir, "marker-blobs"), capabilities: { refuse: () => undefined } };
  diff = "sha256:diff-1";
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const Output = z.object({ verdict: z.string(), note: z.string().optional() });

function step(fact: string, inputs: string[], overrides: Partial<FactEntry> = {}): FactEntry {
  return defineStep({
    name: `step-${fact.replace(":", "-")}`,
    op: "dispatch",
    kind: "software",
    effect: { class: "read" },
    callSites: ["land:1"],
    version: { bump: 0 },
    fact,
    input: z.object({}),
    output: Output,
    materialInputs: inputs.map((input) => ({ fact: input, fields: ["verdict"] })),
    projection: ["verdict"],
    idempotencyKey: () => "key",
    body: "src/fixture-step.ts",
    ...overrides,
  });
}

const chain = [step("mergeability", []), step("verdict:merge", ["mergeability"]), step("conformance:ok", ["verdict:merge"])];

function context(entries: FactEntry[] = chain, now = AT): ValidityContext {
  return { registry: createRegistry(entries), sources: { db, diffPin: (_item, head) => Promise.resolve({ kind: "exact", head, base: SHA_B, main: SHA_B, full: diff, core: diff }) }, now };
}

const verdictOf = (fact: string, ctx = context()) => evaluateFact(ctx, { item: ITEM, fact });

/** Writes a marker as the step would, and returns what a dependent records about it. */
function record(entry: FactEntry, pin: { pinClass: "tree" | "diff" | "observed"; pin: string; expiresAt?: string }, output: object, inputs: Record<string, InputDigest> = {}): InputDigest {
  const bytes = Buffer.from(jcs(output));
  const projection = projectionDigest(entry, output);
  writeMarker(db, store, { item: KEY, fact: entry.fact, ...pin, step: entry.name, callSite: "land:1", version: versionOf(entry), inputDigests: inputs, reads: [{ name: "input", bytes: Buffer.from("read") }], output: bytes, projectionDigest: projection, writtenAt: AT });
  return { pin: pin.pin, projection, output: outputDigest(output) };
}

function push(head: string, expectedEpoch: number): void {
  advanceEpoch(db, { repo: ITEM.repo, pr: ITEM.pr, expectedEpoch, head, by: expectedEpoch === 0 ? "bootstrap" : "non-ancestor", at: AT });
}

let occurrence = 0;
function moveMergeability(): number {
  occurrence += 1;
  return appendEvent(db, { rule: "identity", source: "webhook", kind: "HeadPushed", repo: "o/r", subject: KEY, keys: {}, occurrenceKey: `v1|HeadPushed|${occurrence}`, observedAt: AT, payload: {} }).seq;
}

/** mergeability at seq 0 and the two diff-pinned dependents over it, all valid. */
function recordChain(): void {
  const [mergeability, verdict, conformance] = chain as [FactEntry, FactEntry, FactEntry];
  push(SHA_A, 0);
  const first = record(mergeability, { pinClass: "observed", pin: `${MERGEABILITY}@0/0` }, { verdict: "clean", note: "first" });
  const merge = record(verdict, { pinClass: "diff", pin: diff }, { verdict: "merge" }, { mergeability: first });
  record(conformance, { pinClass: "diff", pin: diff }, { verdict: "ok" }, { "verdict:merge": merge });
}

function rerunMergeability(output: object): void {
  const seq = moveMergeability();
  record(chain[0]!, { pinClass: "observed", pin: `${MERGEABILITY}@${seq}/0` }, output);
}

describe("evaluateFact", () => {
  it("H-L5: a step is not re-run when an input changes outside its projection, and the drift is reported", async () => {
    recordChain();
    rerunMergeability({ verdict: "clean", note: "second" });

    expect(await verdictOf("verdict:merge")).toMatchObject({ status: "valid", drift: ["mergeability"] });
    expect(await verdictOf("conformance:ok")).toMatchObject({ status: "valid", drift: [] });
  });

  it("a dependent is invalid when its input's projection changes", async () => {
    recordChain();
    rerunMergeability({ verdict: "conflicted", note: "first" });

    expect(await verdictOf("verdict:merge")).toMatchObject({ status: "absent", reason: "input-changed", detail: "mergeability" });
    expect(await verdictOf("conformance:ok")).toMatchObject({ status: "absent", reason: "input-absent", detail: "verdict:merge" });
  });

  it("an input re-run with an unchanged projection digest keeps every dependent valid, two levels down", async () => {
    recordChain();
    rerunMergeability({ verdict: "clean", note: "first" });

    expect(await verdictOf("verdict:merge")).toMatchObject({ status: "valid", drift: [] });
    expect(await verdictOf("conformance:ok")).toMatchObject({ status: "valid", drift: [] });
  });

  it("an input with no valid marker at its current pin makes the dependent absent, even with equal recorded digests", async () => {
    recordChain();
    moveMergeability();

    expect(await verdictOf("verdict:merge")).toMatchObject({ status: "absent", reason: "input-absent", detail: "mergeability" });
  });

  it("inputs are checked first: an absent input is the reason even when the step's own pin also moved", async () => {
    recordChain();
    moveMergeability();
    diff = "sha256:diff-2";

    const verdict = await verdictOf("verdict:merge");

    expect(verdict).toMatchObject({ status: "absent", reason: "input-absent", inputs: [{ fact: "mergeability", verdict: { status: "absent", reason: "no-marker" } }] });
  });

  it("C3: a TTL-pinned observed fact is valid before its expiry and absent at it", async () => {
    const hold = step("hold", []);
    record(hold, { pinClass: "observed", pin: "ttl", expiresAt: "2026-11-01T12:05:00.000Z" }, { verdict: "held" });

    expect(await verdictOf("hold", context([hold], "2026-11-01T12:04:59.000Z"))).toMatchObject({ status: "valid" });
    expect(await verdictOf("hold", context([hold], "2026-11-01T12:05:00.000Z"))).toMatchObject({ status: "absent", reason: "ttl-expired" });
  });

  it("a tree-pinned marker from epoch 1 is not valid at the same sha in epoch 3", async () => {
    const ci = step("ci:green", ["head:pushed"]);
    const head = outputDigest({ head: SHA_A });
    push(SHA_A, 0);
    record(ci, { pinClass: "tree", pin: `${SHA_A}@e1` }, { verdict: "green" }, { "head:pushed": { pin: `${SHA_A}@e1`, projection: head, output: head } });
    const atEpoch1 = await verdictOf("ci:green", context([ci]));
    push(SHA_B, 1);
    push(SHA_A, 2);

    expect(atEpoch1).toMatchObject({ status: "valid", drift: [] });
    expect(await verdictOf("ci:green", context([ci]))).toMatchObject({ status: "absent", reason: "no-marker" });
  });

  it("a schema change to the step invalidates its marker; a body change at the same schema hash and bump does not", async () => {
    const hold = step("hold", []);
    record(hold, { pinClass: "observed", pin: "ttl", expiresAt: "2026-11-01T13:00:00.000Z" }, { verdict: "held" });

    const reshaped = step("hold", [], { output: Output.extend({ reason: z.string() }) });
    const rewritten = step("hold", [], { body: "src/fixture-step-v2.ts" });

    expect(await verdictOf("hold", context([reshaped]))).toMatchObject({ status: "absent", reason: "version" });
    expect(await verdictOf("hold", context([rewritten]))).toMatchObject({ status: "valid" });
  });

  it("a marker whose output blob was collected is valid but unreplayable, and names the missing output", async () => {
    const hold = step("hold", []);
    record(hold, { pinClass: "observed", pin: "ttl", expiresAt: "2026-11-01T13:00:00.000Z" }, { verdict: "x".repeat(256 * 1024 + 1) });
    const marker = currentMarker(db, { item: KEY, fact: "hold", pinClass: "observed", pin: "ttl" })!;
    unlinkSync(join(store.blobDir, marker.outputDigest!.slice("sha256:".length)));

    expect(await verdictOf("hold", context([hold]))).toMatchObject({ status: "valid", marker: { id: marker.id } });
    expect(readMarkerValues(db, store, marker.id)).toEqual({ reads: new Map([["input", Buffer.from("read")]]), missing: ["output"] });
  });

  it("a cycle in material inputs is refused, not looped", async () => {
    const cyclic = [step("verdict:merge", ["adversary:merge"]), step("adversary:merge", ["verdict:merge"])];

    expect(await verdictOf("verdict:merge", context(cyclic))).toMatchObject({ status: "absent", reason: "cycle", detail: "adversary:merge" });
  });
});
