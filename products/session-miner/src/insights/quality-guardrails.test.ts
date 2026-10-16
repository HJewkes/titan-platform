import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIST_PRICE_CAVEAT } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "../cli.js";
import { resolveConfig } from "../config.js";
import { createMinerContext } from "../context.js";
import { insightResultSchema } from "./define.js";
import { seedEventsDb, seedInsightGraph } from "./fixture.js";
import { qualityGuardrailsSchema, type QualityGuardrailsReport } from "./quality-guardrails.js";

const AFTER = ["--since", "2026-09-10", "--until", "2026-09-11"];
const BEFORE = ["--before-since", "2026-09-08", "--before-until", "2026-09-09"];
const FILL_KEY = "<50k|claude-opus-5-5";

let offset = 10_000;

/** A reviewer request at 30k fill, the tool use that posts its verdict, and the verdict row the extractor would write. */
function seedVerdict(db: Db, ts: string, verdict: "approve" | "changes_requested", pr: string): void {
  offset += 2;
  const toolUseId = `tu-verdict-${offset}`;
  db.prepare(
    `INSERT INTO request (transcript_id, request_id, byte_offset, session_id, ts, model, input_tokens, cache_read_tokens,
       cache_creation_tokens, cache_creation_5m, cache_creation_1h, output_tokens, context_tokens, is_sidechain)
     VALUES (1, ?, ?, 'rev-1', ?, 'claude-opus-5-5', 30000, 0, 0, 0, 0, 100, 30000, 0)`,
  ).run(`req-verdict-${offset}`, offset, ts);
  db.prepare(
    `INSERT INTO tool_call (transcript_id, byte_offset, block_index, session_id, ts, tool_use_id, name, family, mcp_server, input_chars)
     VALUES (1, ?, 0, 'rev-1', ?, ?, 'mcp__agent-chat__chat_send', 'mcp', 'agent-chat', 1)`,
  ).run(offset + 1, ts, toolUseId);
  db.prepare(
    `INSERT INTO pr_review (source_key, surface, verdict, ts, session_id, transcript_id, number, pr_ref)
     VALUES (?, 'chat', ?, ?, 'rev-1', 1, 1, ?)`,
  ).run(`chat:${toolUseId}:0`, verdict, ts, pr);
}

describe("insights quality-guardrails", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let stateArgs: string[];

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-guardrails-"));
    env = { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), []) };
    const config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, env);
    const ctx = createMinerContext(config);
    const db = ctx.graph().db;
    seedInsightGraph(db);
    seedVerdict(db, "2026-09-08T10:00:00Z", "approve", "acme/widget#1");
    seedVerdict(db, "2026-09-10T10:00:00Z", "approve", "acme/widget#2");
    seedVerdict(db, "2026-09-10T11:00:00Z", "changes_requested", "acme/widget#3");
    ctx.close();
    stateArgs = ["--state", config.stateDir, "--corpus", config.corpusRoot];
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
    let stdout = "";
    const io = { stdout: (t: string) => void (stdout += t), stderr: () => undefined, env };
    const code = await runCli([...stateArgs, ...args], io);
    return { code, stdout };
  }

  async function ask(flags: string[]): Promise<{ answer: QualityGuardrailsReport }> {
    const { code, stdout } = await cli(["--json", "insights", "quality-guardrails", ...flags]);
    expect(code).toBe(0);
    return z.object({ data: insightResultSchema(qualityGuardrailsSchema) }).parse(JSON.parse(stdout)).data;
  }

  it("reports the window's review fill and successor rework with no comparison when no before window is given", async () => {
    const { answer } = await ask(AFTER);

    expect(answer.comparison).toBeNull();
    expect(answer.reviewFill.rows).toEqual([expect.objectContaining({ band: "<50k", verdicts: 2, changesRequested: 1 })]);
    expect(answer.successorRework.window).toEqual({ since: "2026-09-10T00:00:00.000Z", until: "2026-09-11T00:00:00.000Z" });
  });

  it("compares against the before window as after minus before", async () => {
    const { answer } = await ask([...AFTER, ...BEFORE]);
    const row = answer.comparison?.reviewFill.rows.find((r) => r.key === FILL_KEY);

    expect(answer.comparison?.reviewFill.before.window).toEqual({ since: "2026-09-08T00:00:00.000Z", until: "2026-09-09T00:00:00.000Z" });
    expect(row?.before).toMatchObject({ verdicts: 1, changesRequested: 0 });
    expect(row?.delta).toMatchObject({ verdicts: 1, changesRequested: 1 });
  });

  it("passes --boot-requests through to successor rework", async () => {
    const { answer } = await ask([...AFTER, ...BEFORE, "--boot-requests", "5"]);

    expect(answer.successorRework.bootRequests).toBe(5);
    expect(answer.comparison?.successorRework.before.bootRequests).toBe(5);
  });

  it.each([
    ["--before-since alone", ["--before-since", "2026-09-08"]],
    ["--before-until alone", ["--before-until", "2026-09-09"]],
  ])("refuses %s with a usage error", async (_case, flags) => {
    const { code, stdout } = await cli(["--json", "insights", "quality-guardrails", ...AFTER, ...flags]);

    expect(code).toBe(64);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: expect.stringMatching(/--before-since and --before-until/) });
  });

  it("refuses a session filter, since neither report is scoped by session", async () => {
    expect((await cli(["--json", "insights", "quality-guardrails", ...AFTER, "--session", "rev-1"])).code).toBe(65);
  });

  it("renders both reports and both comparisons as text ending with the list-price caveat", async () => {
    const { code, stdout } = await cli(["insights", "quality-guardrails", ...AFTER, ...BEFORE]);

    expect(code).toBe(0);
    expect(stdout).toContain("Review fill, 2026-09-10");
    expect(stdout).toContain("Successor rework, 2026-09-10");
    expect(stdout.match(/Before 2026-09-08/g)).toHaveLength(2);
    expect(stdout.trimEnd().endsWith(LIST_PRICE_CAVEAT)).toBe(true);
  });
});
