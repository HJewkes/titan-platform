import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "@titan-design/store-sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { resolveConfig, type MinerConfig } from "../config.js";
import { createMinerContext } from "../context.js";

let dir: string;
let config: MinerConfig;
let offset = 0;

function insertCall(db: Db, sessionId: string, ts: string, cacheRead: number): void {
  offset += 1;
  db.prepare(
    `INSERT INTO request (transcript_id, request_id, byte_offset, session_id, ts, model, cache_read_tokens, context_tokens)
     VALUES (1, ?, ?, ?, ?, 'claude-opus-5-5', ?, ?)`,
  ).run(`req-${offset}`, offset, sessionId, ts, cacheRead, cacheRead);
}

function insertAutoCompaction(db: Db, sessionId: string, ts: string): void {
  offset += 1;
  db.prepare("INSERT INTO compaction (transcript_id, byte_offset, session_id, ts, trigger) VALUES (1, ?, ?, ?, 'auto')").run(offset, sessionId, ts);
}

/** Seat "hot" sits at p90 305k with one auto-compaction; seat "cool" sits at exactly 300k with none. */
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-seat-context-"));
  config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, {});
  const ctx = createMinerContext(config);
  const db = ctx.graph().db;
  for (let i = 0; i < 10; i += 1) {
    insertCall(db, "hot-1", `2026-10-01T0${i}:00:00Z`, i === 9 ? 305_000 : 100_000);
    insertCall(db, "cool-1", `2026-10-01T0${i}:00:00Z`, i === 9 ? 300_000 : 100_000);
  }
  insertAutoCompaction(db, "hot-1", "2026-10-01T05:00:00Z");
  ctx.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function cli(flags: string[], root: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io = { stdout: (t: string) => void (stdout += t), stderr: (t: string) => void (stderr += t), env: {} };
  const window = ["--since", "2026-10-01", "--until", "2026-10-02"];
  const code = await runCli(["--state", config.stateDir, "--corpus", config.corpusRoot, ...root, "seat-context", ...window, ...flags], io);
  return { code, stdout, stderr };
}

describe("seat-context command", () => {
  it("prints one line per seat and passes a seat at exactly the p90 limit", async () => {
    const { code, stdout } = await cli(["--seat", "cool=cool-1", "--p90-max", "300000", "--auto-max", "0"]);

    expect(code).toBe(0);
    expect(stdout.trim()).toBe("cool  calls 10  p50 100k  p90 300k  max 300k  auto 0  manual 0  PASS");
  });

  it("fails a seat over the p90 limit or the auto-compaction limit and exits 1", async () => {
    const { code, stderr } = await cli(["--seat", "hot=hot-1", "--seat", "cool=cool-1", "--p90-max", "300000", "--auto-max", "0"]);

    expect(code).toBe(1);
    expect(stderr).toContain("hot  calls 10  p50 100k  p90 305k  max 305k  auto 1  manual 0  FAIL p90 305k > 300k; auto-compactions 1 > 0");
    expect(stderr).toContain("cool  calls 10  p50 100k  p90 300k  max 300k  auto 0  manual 0  PASS");
  });

  it("returns the numbers as JSON when no limit is given", async () => {
    const { code, stdout } = await cli(["--seat", "hot=hot-1,missing"], ["--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).data).toEqual([{ name: "hot", requests: 10, p50: 100_000, p90: 305_000, max: 305_000, compactions: { auto: 1, manual: 0 }, failures: [] }]);
  });

  it("refuses a seat spec without session ids", async () => {
    expect((await cli(["--seat", "hot"])).code).toBe(64);
  });
});
