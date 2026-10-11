import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRICE_TABLE, PRICE_TABLE_VERSION, findPrice } from "@titan-design/session-analytics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { resolveConfig } from "../config.js";
import { createMinerContext } from "../context.js";
import { insightResultSchema } from "./define.js";
import { seedEventsDb, seedInsightGraph, seedRequest } from "./fixture.js";
import { comparePrices, priceCheckSchema, type PriceCheck } from "./price-check.js";

const WINDOW = ["--since", "2026-09-10", "--until", "2026-09-11"];
const AT = "2026-09-10T00:00:00.000Z";

function published(model: string, overrides: Record<string, number> = {}) {
  const row = findPrice(model, AT);
  if (row === null) throw new Error(`fixture model ${model} has no table row`);
  const { input, cacheRead, cacheWrite5m, cacheWrite1h, output } = row;
  return { model, input, cacheRead, cacheWrite5m, cacheWrite1h, output, ...overrides };
}

const UNKNOWN = { model: "claude-haiku-9-9", input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 };

describe("comparePrices", () => {
  it("finds no mismatch when the published row equals the table", () => {
    expect(comparePrices([published("claude-opus-5-5"), published("claude-sonnet-5-5")], AT)).toEqual([]);
  });

  it("flags a model whose cache read price alone differs", () => {
    expect(comparePrices([published("claude-opus-5-5", { cacheRead: 0.5 })], AT)).toEqual([
      { model: "claude-opus-5-5", reason: "differs", tableRow: "claude-opus-5-5", fields: [{ field: "cacheRead", published: 0.5, table: 0.2 }] },
    ]);
  });

  it("reports a model no row covers as missing rather than pricing it through a shorter prefix", () => {
    expect(comparePrices([UNKNOWN], AT)).toEqual([{ model: "claude-haiku-9-9", reason: "missing", tableRow: null, fields: [] }]);
  });
});

describe("insights prices", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let stateArgs: string[];

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-prices-"));
    env = { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), []) };
    const config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, env);
    const ctx = createMinerContext(config);
    seedInsightGraph(ctx.graph().db);
    seedRequest(ctx.graph().db, "impl-1", "2026-09-10T04:00:00Z", "claude-mystery-1");
    ctx.close();
    stateArgs = ["--state", config.stateDir, "--corpus", config.corpusRoot];
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const io = { stdout: (t: string) => void (stdout += t), stderr: (t: string) => void (stderr += t), env };
    const code = await runCli([...stateArgs, ...args], io);
    return { code, stdout, stderr };
  }

  function writePublished(name: string, rows: unknown): string {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify(rows));
    return file;
  }

  async function ask(flags: string[]): Promise<PriceCheck> {
    const { code, stdout, stderr } = await cli(["--json", "insights", "prices", ...WINDOW, ...flags]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const data = (JSON.parse(stdout) as { data: unknown }).data;
    expect(insightResultSchema(priceCheckSchema).safeParse(data).success).toBe(true);
    return (data as { answer: PriceCheck }).answer;
  }

  it("returns the table as data and lists a request on an unknown model as unpriced", async () => {
    const answer = await ask([]);

    expect(answer.priceTableVersion).toBe(PRICE_TABLE_VERSION);
    expect(answer.rows).toEqual(PRICE_TABLE);
    expect(answer.unpricedModels).toEqual([expect.objectContaining({ model: "claude-mystery-1", requests: 1 })]);
    expect(answer.mismatches).toBeNull();
  });

  it("compares a --published file and names each mismatch in the text", async () => {
    const file = writePublished("published.json", [published("claude-opus-5-5", { cacheRead: 0.5 }), published("claude-sonnet-5-5"), UNKNOWN]);

    const answer = await ask(["--published", file]);
    const { code, stdout } = await cli(["insights", "prices", ...WINDOW, "--published", file]);

    expect(answer.mismatches?.map((m) => [m.model, m.reason])).toEqual([
      ["claude-opus-5-5", "differs"],
      ["claude-haiku-9-9", "missing"],
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("claude-opus-5-5: differs from row claude-opus-5-5: cacheRead published 0.5, table 0.2");
    expect(stdout).toContain("claude-haiku-9-9: missing");
    expect(stdout).toContain("No cost claim until this is empty.");
    expect(stdout.trimEnd().split("\n").at(-1)).toMatch(/^Price table v\d+/);
  });

  it("refuses a published file that does not match the price shape with a usage error", async () => {
    const file = writePublished("bad.json", [{ model: "claude-opus-5-5", input: "five" }]);

    const { code, stdout } = await cli(["--json", "insights", "prices", ...WINDOW, "--published", file]);

    expect(code).toBe(64);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false });
  });
});
