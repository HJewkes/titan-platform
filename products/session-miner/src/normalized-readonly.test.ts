import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSessionGraph } from "@titan-design/session-graph";
import { hasTable, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { resolveConfig } from "./config.js";
import { seedInsightGraph } from "./insights/fixture.js";
import { MINER_MIGRATIONS } from "./schema.js";
import { serveOptions } from "./serve.js";

let dir: string;
let foreign: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-readonly-"));
  mkdirSync(path.join(dir, "state"));
  foreign = path.join(dir, "foreign.sqlite3");
  const graph = openSessionGraph(foreign);
  runMigrations(graph.db, MINER_MIGRATIONS);
  seedInsightGraph(graph.db);
  expect(hasTable(graph.db, "normalized_event")).toBe(false);
  graph.db.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function ask(args: string[]): Promise<{ code: number; data: unknown; error?: string }> {
  let stdout = "";
  const io = { stdout: (t: string) => void (stdout += t), stderr: () => undefined, env: {} };
  const code = await runCli(["--state", path.join(dir, "state"), "--corpus", path.join(dir, "corpus"), "--graph", foreign, "--json", ...args], io);
  const out = JSON.parse(stdout) as { data: unknown; error?: string };
  return { code, data: out.data, error: out.error };
}

describe("a read-only graph that migration 9 left without normalized tables", () => {
  it("answers status with the legacy session count", async () => {
    const { code, data } = await ask(["status"]);
    expect(code).toBe(0);
    expect(data).toMatchObject({ sessions: 3 });
  });

  it("lists sessions and answers search without throwing", async () => {
    expect((await ask(["session", "list"])).code).toBe(0);
    expect((await ask(["search", "anything"])).code).toBe(0);
  });

  it("reports an unknown session as not found, and drains without normalized error facts", async () => {
    expect((await ask(["session", "show", "no-such-session"])).code).toBe(66);
    expect((await ask(["drain", "templates"])).code).toBe(0);
    // Ingest writes, so a read-only graph refuses it; the refusal must not be a missing normalized table.
    expect((await ask(["drain", "ingest"])).error ?? "").not.toMatch(/normalized_/);
  });

  it("reports health with the legacy session count", () => {
    const config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus"), graph: foreign }, {});
    const health = serveOptions(config).health!();
    expect(health).toMatchObject({ sessions: 3 });
  });
});
