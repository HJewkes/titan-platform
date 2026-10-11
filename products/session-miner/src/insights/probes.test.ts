import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIST_PRICE_CAVEAT } from "@titan-design/session-analytics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { resolveConfig } from "../config.js";
import { createMinerContext } from "../context.js";
import { seedEventsDb, seedRequest, seedToolResults, type FixtureMessage } from "./fixture.js";
import type { ProbesReport } from "./probes.js";

const HEAD = "a".repeat(40);
const WINDOW = ["--since", "2026-09-10", "--until", "2026-09-12"];

const sleepBlock = (id: string, ts: string) => ({ toolUseId: id, sessionId: "impl-1", ts, tool: "Bash", isError: true, text: "Blocked: sleep 60 is not allowed" });

/** Five PRs reviewed on 2026-09-10, four merged on the first verdict; nothing reviewed on 2026-09-11. Every time is near noon UTC, so it is that day in any zone. */
const VERDICTS: FixtureMessage[] = [1, 2, 3, 4, 5].map((pr) => ({
  ts: `2026-09-10T12:0${pr}:00Z`,
  actor: "rev-1",
  target: "coord-a",
  body: `Verdict: ${pr === 5 ? "FIX_FIRST" : "MERGE"}\nPR: acme/widgets#${pr}\nHead: ${HEAD}`,
}));

const PROBES = [
  { id: "P1", task: "DEMO-1", measure: "sleep_blocks", target: 0, op: "<=" },
  { id: "P2", task: "DEMO-2", measure: "first_pass_merge_rate", target: 0.7, op: ">=" },
  { id: "P3", task: "DEMO-3", measure: "verdict_without_pr_line_share", target: 0, op: "<=", since: "2026-09-11" },
];

let dir: string;
let env: NodeJS.ProcessEnv;

function writeProbes(name: string, probes: unknown): string {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(probes));
  return file;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-probes-"));
  env = { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), VERDICTS) };
  const ctx = createMinerContext(resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, env));
  const db = ctx.graph().db;
  seedRequest(db, "impl-1", "2026-09-10T12:00:00Z");
  seedRequest(db, "impl-1", "2026-09-11T12:00:00Z");
  seedToolResults(db, path.join(dir, "demo.jsonl"), [sleepBlock("tu-1", "2026-09-10T12:10:00Z"), sleepBlock("tu-2", "2026-09-10T12:20:00Z")]);
  ctx.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const io = { stdout: (t: string) => void (stdout += t), stderr: () => undefined, env };
  const code = await runCli(["--state", path.join(dir, "state"), "--corpus", path.join(dir, "corpus"), ...args], io);
  return { code, stdout };
}

async function ask(probes: unknown = PROBES): Promise<ProbesReport["rows"]> {
  const { code, stdout } = await cli(["--json", "insights", "probes", "--probes", writeProbes("probes.json", probes), ...WINDOW]);
  expect(code).toBe(0);
  const data = (JSON.parse(stdout) as { data: { question: string; caveat: string; answer: ProbesReport } }).data;
  expect(data).toMatchObject({ question: "Q11", caveat: LIST_PRICE_CAVEAT });
  return data.answer.rows;
}

const row = (rows: ProbesReport["rows"], probe: string, day: string) => rows.find((r) => r.probe === probe && r.day === day);

describe("insights probes (Q11)", () => {
  it("holds a probe on a day that meets its target", async () => {
    const rows = await ask();

    expect(row(rows, "P1", "2026-09-11")).toMatchObject({ value: 0, status: "HOLDING" });
    expect(row(rows, "P2", "2026-09-10")).toEqual({ probe: "P2", task: "DEMO-2", measure: "first_pass_merge_rate", day: "2026-09-10", value: 0.8, op: ">=", target: 0.7, status: "HOLDING" });
  });

  it("regresses a probe on a day that misses its target", async () => {
    const rows = await ask();

    expect(row(rows, "P1", "2026-09-10")).toMatchObject({ value: 2, status: "REGRESSED" });
  });

  it("marks a day its measure has no data for as NO-DATA", async () => {
    const rows = await ask();

    expect(row(rows, "P2", "2026-09-11")).toMatchObject({ value: null, status: "NO-DATA" });
    expect(row(rows, "P3", "2026-09-11")).toMatchObject({ value: null, status: "NO-DATA" });
  });

  it("starts each probe at its own since", async () => {
    const rows = await ask();

    expect(rows.filter((r) => r.probe === "P3").map((r) => r.day)).toEqual(["2026-09-11"]);
  });

  it("refuses a probe file naming an unknown measure as a usage error", async () => {
    const file = writeProbes("unknown.json", [{ id: "P9", task: "DEMO-9", measure: "log_lines_backwards", target: 0, op: "<=" }]);

    const { code, stdout } = await cli(["--json", "insights", "probes", "--probes", file, ...WINDOW]);

    expect(code).toBe(64);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: expect.stringMatching(/measure/) });
  });

  it("refuses the session filters, since probes measure the whole fleet", async () => {
    const { code, stdout } = await cli(["--json", "insights", "probes", "--probes", writeProbes("probes.json", PROBES), "--agent-prefix", "impl-"]);

    expect(code).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: expect.stringMatching(/probes does not take/) });
  });

  it("prints one row per probe per day with the list-price caveat", async () => {
    const { code, stdout } = await cli(["insights", "probes", "--probes", writeProbes("probes.json", PROBES), ...WINDOW]);

    expect(code).toBe(0);
    expect(stdout).toContain("| P1 | sleep_blocks | 2026-09-10 | 2 | <= 0 | REGRESSED | DEMO-1 |");
    expect(stdout).toContain(LIST_PRICE_CAVEAT);
  });
});
