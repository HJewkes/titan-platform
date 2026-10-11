import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { PRICE_LONG_PROMPT_MIGRATION_NAME } from "./price-long-prompt-schema.js";
import { syncPrices, type PriceInput } from "./prices.js";
import { MIGRATIONS } from "./schema.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-m13-"));
  file = path.join(dir, "graph.sqlite3");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const GENESIS = "2026-01-01";
const OPUS: PriceInput = { modelPrefix: "claude-opus-5", effectiveFrom: GENESIS, input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 };
const HAIKU_5_5: PriceInput = {
  modelPrefix: "claude-haiku-5-5", effectiveFrom: GENESIS, input: 0.1, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2, output: 0.5,
  longPrompt: { abovePromptTokens: 100_000, input: 0.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1, output: 2.5 },
};

const COMPONENTS = ["input_cost_usd", "cache_read_cost_usd", "cache_write_5m_cost_usd", "cache_write_1h_cost_usd", "output_cost_usd"] as const;

/** Prompt split across input, cache read and both cache writes, so every component has tokens and context_tokens is their sum. */
function insertRequest(db: SessionGraph["db"], requestId: string, model: string, promptTokens: number): void {
  const write5m = 10_000;
  const write1h = 10_000;
  const input = 1_000;
  db.prepare(
    `INSERT INTO request (transcript_id, request_id, byte_offset, session_id, ts, model, input_tokens, cache_read_tokens,
       cache_creation_tokens, cache_creation_5m, cache_creation_1h, output_tokens, context_tokens)
     VALUES (1, ?, 0, 's', '2026-09-01T00:00:00Z', ?, ?, ?, ?, ?, ?, 1000, ?)`,
  ).run(requestId, model, input, promptTokens - input - write5m - write1h, write5m + write1h, write5m, write1h, promptTokens);
}

const expectCloseTo = (values: number[]) => values.map((v) => expect.closeTo(v, 6));

type CostRow = Record<"cost_usd" | "priced" | (typeof COMPONENTS)[number], number>;

function costRow(graph: SessionGraph, requestId: string): CostRow {
  const row = graph.db.prepare<[string], CostRow>("SELECT * FROM request_cost WHERE request_id = ?").get(requestId);
  if (!row) throw new Error(`no request_cost row for ${requestId}`);
  return row;
}

function versionTwelveGraphWithOpusRequest(): number {
  const db = openDatabase(file);
  runMigrations(db, MIGRATIONS.slice(0, 12));
  db.prepare("INSERT INTO price VALUES ('claude-opus-5', '2026-01-01', 1, 5, 0.5, 6.25, 10, 25, NULL)").run();
  insertRequest(db, "opus", "claude-opus-5", 150_000);
  const before = db.prepare<[], { cost_usd: number }>("SELECT cost_usd FROM request_cost").get()?.cost_usd;
  if (before === undefined) throw new Error("no request_cost row for the version 12 request");
  db.close();
  return before;
}

describe("migration 13", () => {
  it("prices a row with no long-prompt tier exactly as before the migration", () => {
    const before = versionTwelveGraphWithOpusRequest();

    const graph = openSessionGraph(file);

    expect(PRICE_LONG_PROMPT_MIGRATION_NAME).toBe("price long-prompt tier");
    expect(costRow(graph, "opus").cost_usd).toBeCloseTo(before, 12);
    expect(graph.db.prepare("SELECT long_prompt_above_tokens FROM price").get()).toEqual({ long_prompt_above_tokens: null });
    graph.db.close();
  });

  it("bills every component at the long rate only when the prompt is strictly above the threshold", () => {
    const graph = openSessionGraph(file);
    syncPrices(graph, [OPUS, HAIKU_5_5], { tableVersion: 1 });
    insertRequest(graph.db, "at", "claude-haiku-5-5", 100_000);
    insertRequest(graph.db, "above", "claude-haiku-5-5", 100_001);

    const at = costRow(graph, "at");
    const above = costRow(graph, "above");

    expect(COMPONENTS.map((c) => at[c] * 1e6)).toEqual(expectCloseTo([1_000 * 0.1, 79_000 * 0.01, 10_000 * 0.125, 10_000 * 0.2, 1_000 * 0.5]));
    expect(COMPONENTS.map((c) => above[c] * 1e6)).toEqual(expectCloseTo([1_000 * 0.5, 79_001 * 0.05, 10_000 * 0.625, 10_000 * 1, 1_000 * 2.5]));
    graph.db.close();
  });

  it("leaves an unknown model unpriced whatever its prompt size", () => {
    const graph = openSessionGraph(file);
    syncPrices(graph, [HAIKU_5_5], { tableVersion: 1 });
    insertRequest(graph.db, "r", "claude-haiku-5-6", 400_000);

    expect(costRow(graph, "r")).toMatchObject({ priced: 0, cost_usd: 0 });
    graph.db.close();
  });
});
