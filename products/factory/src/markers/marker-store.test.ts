import { mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { CapabilityLeakError } from "@titan-design/workflow";
import { getBlob, putBlob, type BlobStore, type CapabilityGuard } from "./blob-store.js";
import { currentMarker, markerHistory, readMarkerValues, writeMarker, type MarkerInput } from "./marker-store.js";
import { markerTableMigration } from "./marker-table.js";

const AT = "2026-11-01T12:00:00.000Z";
const LIMIT = 256 * 1024;
const SECRET = "synthetic-secret-token-0001";

/** Stands in for the runtime's vault: refuses any string holding the secret. */
const vault: CapabilityGuard = {
  refuse(value, where) {
    if (typeof value === "string" && value.includes(SECRET)) throw new CapabilityLeakError(where);
  },
};

let dir: string;
let db: Db;
let store: BlobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marker-store-"));
  db = openDatabase(join(dir, "factory.db"));
  runMigrations(db, [markerTableMigration()]);
  store = { blobDir: join(dir, "marker-blobs"), capabilities: vault };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const bytes = (n: number, fill = 0x61): Buffer => Buffer.alloc(n, fill);
const files = (): string[] => {
  try {
    return readdirSync(store.blobDir);
  } catch {
    return [];
  }
};

function marker(overrides: Partial<MarkerInput> = {}): MarkerInput {
  return {
    item: "o/r#7",
    fact: "ci",
    pinClass: "tree",
    pin: "a".repeat(40),
    step: "check-ci",
    callSite: "land:1",
    version: "v1",
    inputDigests: {},
    reads: [{ name: "conclusion", bytes: Buffer.from("success") }],
    writtenAt: AT,
    ...overrides,
  };
}

const blobRows = (): number => (db.prepare("SELECT COUNT(*) AS n FROM factory_marker_blob").get() as { n: number }).n;
const markerRows = (): number => (db.prepare("SELECT COUNT(*) AS n FROM factory_marker").get() as { n: number }).n;

describe("blob tiers", () => {
  it("a 256 KB read value is stored inline, and 256 KB + 1 byte goes to a file out of line", () => {
    const small = putBlob(db, store, bytes(LIMIT), AT);
    const large = putBlob(db, store, bytes(LIMIT + 1), AT);

    const rows = db.prepare("SELECT digest, inline IS NOT NULL AS inl, path FROM factory_marker_blob").all() as { digest: string; inl: number; path: string | null }[];
    expect(rows.find((r) => r.digest === small)).toMatchObject({ inl: 1, path: null });
    expect(rows.find((r) => r.digest === large)).toMatchObject({ inl: 0, path: large.slice("sha256:".length) });
    expect(files()).toEqual([large.slice("sha256:".length)]);
  });

  it("round-trips inline and out-of-line values", () => {
    const small = putBlob(db, store, bytes(10), AT);
    const large = putBlob(db, store, bytes(LIMIT + 1, 0x62), AT);

    expect(getBlob(db, store, small)).toEqual(bytes(10));
    expect(getBlob(db, store, large)).toEqual(bytes(LIMIT + 1, 0x62));
  });

  it("two markers that read the same value share one blob row", () => {
    writeMarker(db, store, marker());
    writeMarker(db, store, marker({ pin: "b".repeat(40) }));

    expect(blobRows()).toBe(1);
    expect(markerRows()).toBe(2);
  });

  it("the same large content is stored once, as one file", () => {
    putBlob(db, store, bytes(LIMIT + 1), AT);
    putBlob(db, store, bytes(LIMIT + 1), AT);

    expect(blobRows()).toBe(1);
    expect(files()).toHaveLength(1);
  });

  it("leaves no temp file behind and names files from the digest only", () => {
    const digest = putBlob(db, store, bytes(LIMIT + 1), AT);

    expect(files()).toEqual([digest.slice("sha256:".length)]);
    expect(getBlob(db, store, "sha256:../../etc/passwd")).toBeUndefined();
  });
});

describe("missing blobs", () => {
  it("a marker whose blob is gone reads as missing, not an error", () => {
    const { id } = writeMarker(db, store, marker({ reads: [{ name: "log", bytes: bytes(LIMIT + 1) }], output: Buffer.from("out") }));
    for (const file of files()) unlinkSync(join(store.blobDir, file));
    db.prepare("DELETE FROM factory_marker_blob WHERE inline IS NOT NULL").run();

    expect(readMarkerValues(db, store, id)).toEqual({ missing: ["log", "output"] });
  });

  it("a stored marker reads back its recorded values", () => {
    const { id } = writeMarker(db, store, marker({ output: Buffer.from("out") }));

    const values = readMarkerValues(db, store, id);
    expect(values).toEqual({ reads: new Map([["conclusion", Buffer.from("success")]]), output: Buffer.from("out") });
  });
});

describe("capability guard", () => {
  const guarded = (): BlobStore => store;

  it("a write is refused when the store has no capability guard, and nothing is written", () => {
    const unguarded: BlobStore = { blobDir: store.blobDir };

    expect(() => writeMarker(db, unguarded, marker())).toThrow(/no capability guard/);
    expect(() => putBlob(db, unguarded, bytes(LIMIT + 1), AT)).toThrow(/no capability guard/);
    expect(blobRows()).toBe(0);
    expect(markerRows()).toBe(0);
    expect(files()).toEqual([]);
  });

  it("a read value carrying a refused capability is refused before any blob is written", () => {
    const refusing = guarded();
    const input = marker({ reads: [{ name: "ok", bytes: bytes(LIMIT + 1) }, { name: "leak", bytes: Buffer.from(`token ${SECRET}`) }] });

    expect(() => writeMarker(db, refusing, input)).toThrow(CapabilityLeakError);
    expect(blobRows()).toBe(0);
    expect(markerRows()).toBe(0);
    expect(files()).toEqual([]);
  });

  it("an output carrying a refused capability is refused", () => {
    expect(() => writeMarker(db, guarded(), marker({ output: Buffer.from(SECRET) }))).toThrow(CapabilityLeakError);
    expect(markerRows()).toBe(0);
  });

  it("putBlob refuses a secret", () => {
    expect(() => putBlob(db, guarded(), Buffer.from(SECRET), AT)).toThrow(CapabilityLeakError);
    expect(blobRows()).toBe(0);
  });
});

describe("failed writes", () => {
  it("a write that fails inside the transaction leaves only an orphan blob, which no marker references", () => {
    const failing = marker({ reads: [{ name: "log", bytes: bytes(LIMIT + 1) }], pinClass: "bogus" as never });

    expect(() => writeMarker(db, store, failing)).toThrow();
    expect(markerRows()).toBe(0);
    expect(blobRows()).toBe(0);
    expect(files()).toHaveLength(1);
  });
});

describe("history", () => {
  it("markerHistory returns superseded rows oldest first, with their input digests", () => {
    const first = writeMarker(db, store, marker({ inputDigests: { build: { pin: "p1", projection: "sha256:1" } } }));
    const second = writeMarker(db, store, marker({ inputDigests: { build: { pin: "p2", projection: "sha256:2" } } }));

    const history = markerHistory(db, { item: "o/r#7", fact: "ci" });
    expect(history.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(history.map((r) => r.inputDigests.build?.pin)).toEqual(["p1", "p2"]);
    expect(currentMarker(db, { item: "o/r#7", fact: "ci", pinClass: "tree", pin: "a".repeat(40) })?.id).toBe(second.id);
  });
});
