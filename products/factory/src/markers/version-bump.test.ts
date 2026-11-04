import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { eventLogMigration } from "../event-log/event-log.js";
import { advanceEpoch, headEpochMigration, readEpoch } from "../head-guard/epoch-store.js";
import { defineStep, type FactEntry } from "../registry/entry.js";
import { createRegistry } from "../registry/registry.js";
import type { BlobStore } from "./blob-store.js";
import { markersBehindVersion, writeMarker } from "./marker-store.js";
import { markerTableMigration } from "./marker-table.js";
import { evaluateFact, versionOf, type ValidityContext } from "./validity.js";

const SHA = "a".repeat(40);
const AT = "2026-11-01T12:00:00.000Z";
const PRS = [7, 8, 9];

let dir: string;
let db: Db;
let store: BlobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "version-bump-"));
  db = openDatabase(join(dir, "factory.db"));
  runMigrations(db, [markerTableMigration(), eventLogMigration(30), headEpochMigration(34)]);
  store = { blobDir: join(dir, "marker-blobs"), capabilities: { refuse: () => undefined } };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function step(name: string, fact: string, inputs: string[], bump: number, body = "src/fixture-step.ts"): FactEntry {
  return defineStep({
    name,
    op: "dispatch",
    kind: "software",
    effect: { class: "read" },
    callSites: ["land:1"],
    version: { bump },
    fact,
    input: z.object({}),
    output: z.object({ verdict: z.string() }),
    materialInputs: inputs.map((input) => ({ fact: input, fields: ["verdict"] })),
    projection: ["verdict"],
    idempotencyKey: () => "key",
    body,
  });
}

const ciWait = (bump: number, body?: string) => step("ci-wait", "ci:green", [], bump, body);
const merge = (bump = 0) => step("merge", "landed", ["ci:green"], bump);

function context(entries: FactEntry[]): ValidityContext {
  return { registry: createRegistry(entries), sources: { db }, now: AT };
}

function record(entry: FactEntry, pr: number): number {
  const item = { repo: "O/R", pr };
  if (readEpoch(db, item) === undefined) advanceEpoch(db, { ...item, expectedEpoch: 0, head: SHA, by: "bootstrap", at: AT });
  const epoch = readEpoch(db, item)!;
  const pin = { pinClass: "tree" as const, pin: `${epoch.head}@e${epoch.epoch}` };
  return writeMarker(db, store, { item: `o/r#${pr}`, fact: entry.fact, ...pin, step: entry.name, callSite: "land:1", version: versionOf(entry), inputDigests: {}, reads: [], writtenAt: AT }).id;
}

describe("a version bump", () => {
  it("a bump invalidates every marker of the step on every item, and no marker of another step", async () => {
    const before = ciWait(0);
    const stale = PRS.map((pr) => record(before, pr));
    record(merge(), 7);
    const bumped = ciWait(1);
    const ctx = context([bumped, merge()]);

    for (const pr of PRS) expect(await evaluateFact(ctx, { item: { repo: "O/R", pr }, fact: "ci:green" })).toMatchObject({ status: "absent", reason: "version" });
    expect(await evaluateFact(ctx, { item: { repo: "O/R", pr: 7 }, fact: "landed" })).not.toMatchObject({ reason: "version" });
    expect(markersBehindVersion(db, "ci-wait", versionOf(bumped)).map((row) => row.id)).toEqual(stale);
    expect(markersBehindVersion(db, "ci-wait", versionOf(bumped)).map((row) => row.fact)).toEqual(["ci:green", "ci:green", "ci:green"]);
  });

  it("a superseded row of an old version is not listed beside the current one", () => {
    const before = ciWait(0);
    record(before, 7);
    const current = record(before, 7);

    expect(markersBehindVersion(db, "ci-wait", versionOf(ciWait(1))).map((row) => row.id)).toEqual([current]);
  });

  it("a closure change with no schema change and no bump leaves every marker valid", async () => {
    for (const pr of PRS) record(ciWait(0), pr);
    const edited = ciWait(0, "src/another-body.ts");
    const ctx = context([edited]);

    for (const pr of PRS) expect(await evaluateFact(ctx, { item: { repo: "O/R", pr }, fact: "ci:green" })).toMatchObject({ status: "valid" });
    expect(markersBehindVersion(db, "ci-wait", versionOf(edited))).toEqual([]);
  });
});
