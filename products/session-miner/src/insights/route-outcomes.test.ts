import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { resolveConfig, type MinerConfig } from "../config.js";
import { createMinerContext } from "../context.js";
import { seedEventsDb } from "./fixture.js";
import { routeOutcomeSchema } from "./route-outcomes.js";
import { insightResultSchema } from "./define.js";

let dir: string;
let config: MinerConfig;
let env: NodeJS.ProcessEnv;

const SINCE = "2026-10-06T00:00:00.000Z";

function seedSpawn(db: ReturnType<ReturnType<typeof createMinerContext>["graph"]>["db"], id: string, spawnedAt: string): void {
  db.prepare(
    `INSERT INTO session_origin (session_id, origin_system, depth, profile, task_ids, task_source, resolved_at, spawned_at,
       route_mode, route_source, route_prior, route_table, route_wanted, route_facts)
     VALUES (?, 'agent-chat', 1, 'bd-implementer-lite', '["DEMO-1"]', 'name', ?, ?, 'shadow', 'auto', 'standard', 'shape-v1@0000abcd', 'bd-implementer-lite', '{"estimate":2}')`,
  ).run(id, spawnedAt, spawnedAt);
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-route-outcomes-"));
  env = { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), []) };
  config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, env);
  const ctx = createMinerContext(config);
  const db = ctx.graph().db;
  seedSpawn(db, "before-window", "2026-10-05T23:59:59.000Z");
  seedSpawn(db, "at-window-start", SINCE);
  seedSpawn(db, "inside-window", "2026-10-08T09:00:00.000Z");
  ctx.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io = { stdout: (t: string) => void (stdout += t), stderr: (t: string) => void (stderr += t), env };
  const code = await runCli(["--state", config.stateDir, "--corpus", config.corpusRoot, ...args], io);
  return { code, stdout, stderr };
}

describe("route-outcomes (Q15)", () => {
  it("prints JSON matching the schema, counting the spawn at the window start and not the one a second before", async () => {
    const { code, stdout } = await cli(["--json", "insights", "route-outcomes", "--since", SINCE]);

    expect(code).toBe(0);
    const envelope = z.object({ ok: z.literal(true), data: insightResultSchema(routeOutcomeSchema) }).parse(JSON.parse(stdout));
    const result = envelope.data;
    expect(result.answer.since).toBe(SINCE);
    expect(result.answer.groups).toHaveLength(1);
    expect(result.answer.groups[0]).toMatchObject({ table: "shape-v1@0000abcd", prior: "standard", estimateBand: "2", agreement: "agree", spawns: 2 });
  });

  it("refuses --until, which the query cannot honour", async () => {
    const { code } = await cli(["--json", "insights", "route-outcomes", "--since", SINCE, "--until", "2026-10-09"]);

    expect(code).toBe(65);
  });
});
