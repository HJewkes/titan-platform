import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EVENTS_TABLE_DDL } from "@titan-design/session-analytics";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "../cli.js";
import { resolveConfig } from "../config.js";
import { createMinerContext } from "../context.js";
import { insightResultSchema } from "./define.js";
import { seedInsightGraph } from "./fixture.js";
import { seatGenerationsReportSchema, type SeatGenerationsReport } from "./seat-generations.js";

const SEAT = "coord-alpha";
const WINDOW = ["--since", "2026-09-10T00:00:00Z", "--until", "2026-09-11T00:00:00Z"];

const log = (ts: string, event: string, fields: Record<string, unknown>) => JSON.stringify({ ts, event, ...fields });

const BROKER = [
  log("2026-09-08T00:00:00.000Z", "agent_spawned", { agentId: "id-old", name: SEAT }),
  log("2026-09-09T00:00:00.000Z", "agent_exited", { agentId: "id-old", name: SEAT, code: 0 }),
  log("2026-09-10T00:30:00.000Z", "agent_spawned", { agentId: "id-coord-alpha", name: SEAT }),
  log("2026-09-10T09:00:00.000Z", "teleport_completed", { name: SEAT, from: "id-coord-alpha-2", to: "id-coord-alpha-3" }),
].join("\n");

const HANDOFFS = [
  { ts: "2026-09-10T06:00:00Z", kind: "agent_handoff", actor: SEAT, ref: "id-coord-alpha", meta: { successor: "id-coord-alpha-2" } },
  { ts: "2026-09-10T06:01:00Z", kind: "agent_stood_down", actor: SEAT, ref: "id-coord-alpha" },
  { ts: "2026-09-10T07:00:00Z", kind: "agent_handoff", actor: "coord-other", ref: "id-other", meta: { successor: "id-other-2" } },
  { ts: "2026-09-10T07:01:00Z", kind: "agent_stood_down", actor: "coord-other", ref: "id-other" },
];

function seedHandoffs(file: string): string {
  const db = openDatabase(file);
  db.exec(EVENTS_TABLE_DDL);
  const insert = db.prepare("INSERT INTO events (ts, kind, actor, ref, meta) VALUES (?, ?, ?, ?, ?)");
  for (const e of HANDOFFS) insert.run(Date.parse(e.ts), e.kind, e.actor, e.ref, "meta" in e ? JSON.stringify(e.meta) : null);
  db.close();
  return file;
}

describe("insights seat-generations", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let stateArgs: string[];

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-generations-"));
    const brokerLog = path.join(dir, "broker.log");
    writeFileSync(brokerLog, BROKER);
    env = { TITAN_MINER_EVENTS_DB: seedHandoffs(path.join(dir, "events.db")), TITAN_MINER_BROKER_LOG: brokerLog };
    const config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, env);
    const ctx = createMinerContext(config);
    seedInsightGraph(ctx.graph().db);
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

  async function ask(flags: string[]): Promise<SeatGenerationsReport> {
    const { code, stdout } = await cli(["--json", "insights", "seat-generations", "--seat", SEAT, ...flags]);
    expect(code).toBe(0);
    return z.object({ data: insightResultSchema(seatGenerationsReportSchema) }).parse(JSON.parse(stdout)).data.answer;
  }

  it("lists the window's generations in order with how each ended, dropping one that ended before since", async () => {
    const answer = await ask(WINDOW);

    expect(answer.generations.map((g) => [g.generation, g.agentId, g.endedBy, g.sessionIds])).toEqual([
      [1, "id-coord-alpha", "handoff", ["seat-1"]],
      [2, "id-coord-alpha-2", "teleport", []],
      [3, "id-coord-alpha-3", "open", []],
    ]);
  });

  it("builds the session argument string from graph sessions only, skipping generations with none", async () => {
    const answer = await ask(WINDOW);
    const { stdout } = await cli(["insights", "seat-generations", "--seat", SEAT, ...WINDOW]);

    expect(answer.sessionArgs).toBe("--session seat-1");
    expect(stdout).toContain("2. id-coord-alpha-2 from 2026-09-10T06:00:00.000Z to 2026-09-10T09:00:00.000Z, ended by teleport; sessions: none in the graph");
    expect(stdout).toContain("Graph questions over these generations: --session seat-1");
  });

  it("leaves out a generation that started at or after until", async () => {
    const answer = await ask(["--since", "2026-09-10T00:00:00Z", "--until", "2026-09-10T08:00:00Z"]);

    expect(answer.generations.map((g) => g.agentId)).toEqual(["id-coord-alpha", "id-coord-alpha-2"]);
  });

  it("refuses --session, since the seat names the scope", async () => {
    const { code, stdout } = await cli(["--json", "insights", "seat-generations", "--seat", SEAT, "--session", "seat-1"]);

    expect(code).toBe(65);
    expect(stdout).toContain("seat-generations does not take sessionIds");
  });
});
