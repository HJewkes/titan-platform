import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHealthStore, readSamples, storeStats } from "@titan-design/health";
import { runCli } from "../cli.js";
import { parseStopgap } from "./import-stopgap.js";

const STOPGAP_LINES = [
  '{"ts":"2026-10-05T13:22:00Z","up":true,"code":200,"secs":0.012,"sha":"abc1234","running":2,"pendingGates":1}',
  '{"ts":"2026-10-05T13:23:00Z","up":false,"code":0,"secs":5.001,"sha":"","running":0,"pendingGates":0}',
  "not json at all",
  "",
];

let dir: string;
let dbPath: string;
let jsonl: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "titan-import-"));
  dbPath = join(dir, "health.sqlite3");
  jsonl = join(dir, "shepherd-health.jsonl");
  await writeFile(jsonl, STOPGAP_LINES.join("\n"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function importStopgap(...extra: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["health", "import", jsonl, "--db", dbPath, ...extra], {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: {},
    home: dir,
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

function rowCount(): number {
  const db = openHealthStore(dbPath, { readonly: true });
  try {
    return storeStats(db).rows;
  } finally {
    db.close();
  }
}

describe("titan health import", () => {
  it("gives the same row count when the same file is imported twice", async () => {
    const first = await importStopgap();
    const second = await importStopgap();

    expect(first).toMatchObject({ code: 0 });
    expect(first.stdout).toContain("imported 2, duplicate 0, bad 1");
    expect(second.stdout).toContain("imported 0, duplicate 2, bad 1");
    expect(rowCount()).toBe(2);
  });

  it("maps a stopgap row to an http sample of the target", async () => {
    await importStopgap("--target", "factory");

    const db = openHealthStore(dbPath, { readonly: true });
    const rows = readSamples(db, "factory", new Date("2026-10-05T00:00:00Z"), new Date("2026-10-06T00:00:00Z"));
    db.close();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ts: "2026-10-05T13:22:00Z",
      kind: "http",
      status: "pass",
      latencyMs: 12,
      source: "import:shepherd-health",
      observed: { code: 200, "build.sha": "abc1234", running: 2, pendingGates: 1 },
    });
    expect(rows[1]).toMatchObject({ status: "fail" });
  });

  it("exits 2 naming the file when it cannot be read", async () => {
    const missing = join(dir, "missing.jsonl");
    const out: string[] = [];
    const err: string[] = [];

    const code = await runCli(["health", "import", missing, "--db", dbPath], { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: {}, home: dir });

    expect(code).toBe(2);
    expect(err.join("")).toContain(missing);
  });
});

describe("parseStopgap", () => {
  it("keys each row by file name and line, never by when it was imported", () => {
    const text = STOPGAP_LINES[0] ?? "";

    const a = parseStopgap(text, "shepherd-health.jsonl", "factory");
    const b = parseStopgap(text, "shepherd-health.jsonl", "factory");
    const other = parseStopgap(text, "other.jsonl", "factory");

    expect(a.samples[0]?.dedupKey).toBe(b.samples[0]?.dedupKey);
    expect(a.samples[0]?.dedupKey).not.toBe(other.samples[0]?.dedupKey);
  });

  it("counts a row with an impossible field as bad instead of failing the whole file", () => {
    const text = ['{"ts":"yesterday","up":true,"secs":1}', '{"ts":"2026-10-05T13:22:00Z","up":true,"secs":-1}', STOPGAP_LINES[0]].join("\n");

    const parsed = parseStopgap(text, "f.jsonl", "factory");

    expect(parsed).toMatchObject({ bad: 2 });
    expect(parsed.samples).toHaveLength(1);
  });

  it("omits observed fields the row does not carry", () => {
    const parsed = parseStopgap('{"ts":"2026-10-05T13:22:00Z","up":true}', "f.jsonl", "factory");

    expect(parsed.samples[0]).not.toHaveProperty("latencyMs");
    expect(parsed.samples[0]).not.toHaveProperty("observed");
  });
});
