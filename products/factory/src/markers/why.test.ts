import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { eventLogMigration } from "../event-log/event-log.js";
import { defineStep, type FactEntry } from "../registry/entry.js";
import { createRegistry } from "../registry/registry.js";
import type { BlobStore } from "./blob-store.js";
import { jcs } from "./jcs.js";
import { writeMarker, type InputDigest } from "./marker-store.js";
import { markerTableMigration } from "./marker-table.js";
import { outputDigest, projectionDigest } from "./projection.js";
import { versionOf } from "./validity.js";
import { explainFact } from "./why.js";

const ITEM = { repo: "Fixture/Repo", pr: 7 };
const KEY = "fixture/repo#7";
const AT = "2026-11-01T12:00:00.000Z";
const TTL = { pinClass: "observed" as const, pin: "ttl", expiresAt: "2026-11-01T12:05:00.000Z" };

let dir: string;
let db: Db;
let blobs: BlobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marker-why-"));
  db = openDatabase(join(dir, "factory.db"));
  runMigrations(db, [markerTableMigration(), eventLogMigration(30)]);
  blobs = { blobDir: join(dir, "marker-blobs"), capabilities: { refuse: () => undefined } };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function step(fact: string, inputs: string[]): FactEntry {
  return defineStep({
    name: `step-${fact}`,
    op: "dispatch",
    kind: "software",
    effect: { class: "read" },
    callSites: ["fixture"],
    version: { bump: 0 },
    fact,
    input: z.object({}),
    output: z.object({ verdict: z.string(), note: z.string().optional() }),
    materialInputs: inputs.map((input) => ({ fact: input, fields: ["verdict"] })),
    projection: ["verdict"],
    idempotencyKey: () => "key",
    body: "src/fixture-step.ts",
  });
}

const hold = step("hold", []);
const roster = step("roster", ["hold"]);

function record(entry: FactEntry, output: object, inputs: Record<string, InputDigest> = {}): InputDigest {
  const projection = projectionDigest(entry, output);
  writeMarker(db, blobs, { item: KEY, fact: entry.fact, ...TTL, step: entry.name, callSite: "fixture", version: versionOf(entry), inputDigests: inputs, reads: [], output: Buffer.from(jcs(output)), projectionDigest: projection, runId: "run-1", writtenAt: AT });
  return { pin: TTL.pin, projection, output: outputDigest(output) };
}

const why = (fact: string, now: string) => explainFact({ registry: createRegistry([hold, roster]), sources: { db }, now, blobs }, { item: ITEM, fact });

describe("markers why", () => {
  it("why prints would be stale on full inputs for a drifted input", async () => {
    const recorded = record(hold, { verdict: "held", note: "first" });
    record(roster, { verdict: "ok" }, { hold: recorded });
    record(hold, { verdict: "held", note: "second" });

    const lines = await why("roster", "2026-11-01T12:01:00.000Z");

    expect(lines[0]).toBe(`roster at ${KEY}: valid`);
    expect(lines).toContain("  would be stale on full inputs: hold");
  });

  it("why names an expired TTL pin and the input that made a fact absent", async () => {
    record(roster, { verdict: "ok" }, { hold: record(hold, { verdict: "held" }) });

    const lines = await why("roster", "2026-11-01T12:05:00.000Z");

    expect(lines.slice(0, 2)).toEqual([`roster at ${KEY}: absent, input-absent: hold`, `  input hold: absent, ttl-expired: ${TTL.expiresAt}`]);
    expect(lines).toContain("history: 1 row");
  });
});
