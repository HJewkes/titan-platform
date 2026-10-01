import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LivenessReport } from "@titan-design/session-analytics";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { resolveConfig } from "../config.js";
import { startMiner } from "../serve.js";

const WINDOW = ["--since", "2026-09-12T00:00:00Z", "--until", "2026-09-12T12:00:00Z"];

const log = (time: string, event: string, fields: Record<string, unknown>) => JSON.stringify({ ts: `2026-09-12T${time}.000Z`, event, ...fields });

const BROKER = [
  log("08:00:00", "registered", { name: "seat-a" }),
  log("08:10:00", "deregistered", { name: "seat-a", reason: "connection closed" }),
  log("08:20:00", "route", { kind: "message", from: "impl-1", to: "seat-a", delivered: false, recipients: [] }),
  log("08:30:00", "registered", { name: "seat-a" }),
  log("09:00:00", "unreported-exit", { agentId: "a1", name: "impl-1", spawner: "seat-a", lastAction: "chat_send" }),
].join("\n");

interface EventFixture {
  ts: string;
  kind: string;
  actor: string;
  target?: string;
  msgId?: string;
  ref?: string;
  meta?: unknown;
}

const EVENTS: EventFixture[] = [
  { ts: "2026-09-12T07:00:00Z", kind: "agent_spawned", actor: "seat-a", target: "impl-1", msgId: "a1", meta: { profile: "implementer" } },
  { ts: "2026-09-12T10:00:00Z", kind: "approval_request", actor: "rev-1", target: "human", msgId: "p1", meta: { tool_name: "Bash" } },
  { ts: "2026-09-12T10:30:00Z", kind: "approval_request", actor: "rev-2", target: "human", msgId: "p2", meta: { tool_name: "Edit" } },
  { ts: "2026-09-12T10:31:00Z", kind: "resolution", actor: "human", ref: "p2" },
  { ts: "2026-09-12T10:40:00Z", kind: "approval_request", actor: "impl-1", target: "human", msgId: "p3", meta: "not json" },
  { ts: "2026-09-12T10:45:00Z", kind: "message", actor: "rev-3", target: "seat-a" },
  { ts: "2026-09-12T13:00:00Z", kind: "message", actor: "rev-1", target: "seat-a" },
];

function seedEvents(file: string): string {
  const db = openDatabase(file);
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
    target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)`);
  const insert = db.prepare("INSERT INTO events (ts, kind, actor, target, msg_id, ref, meta) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const e of EVENTS) insert.run(Date.parse(e.ts), e.kind, e.actor, e.target ?? null, e.msgId ?? null, e.ref ?? null, typeof e.meta === "string" ? e.meta : e.meta && JSON.stringify(e.meta));
  db.close();
  return file;
}

let dir: string;
let env: NodeJS.ProcessEnv;
let brokerLog: string;
let eventsDb: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-liveness-"));
  eventsDb = seedEvents(path.join(dir, "events.db"));
  brokerLog = path.join(dir, "broker.log");
  writeFileSync(brokerLog, BROKER);
  env = { TITAN_MINER_EVENTS_DB: eventsDb, TITAN_MINER_BROKER_LOG: brokerLog };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[], cliEnv = env): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const io = { stdout: (t: string) => void (stdout += t), stderr: () => undefined, env: cliEnv };
  const code = await runCli(["--state", path.join(dir, "state"), "--corpus", path.join(dir, "corpus"), ...args], io);
  return { code, stdout };
}

async function ask(flags: string[], cliEnv = env): Promise<LivenessReport> {
  const { code, stdout } = await cli(["--json", "insights", "liveness", ...flags], cliEnv);
  expect(code).toBe(0);
  return (JSON.parse(stdout) as { data: { answer: LivenessReport } }).data.answer;
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("insights liveness", () => {
  it("finds a dark seat with the route that missed it, from TITAN_MINER_BROKER_LOG", async () => {
    const answer = await ask(WINDOW);

    expect(answer.darkSeats.rows).toEqual([
      { seat: "seat-a", from: "2026-09-12T08:10:00.000Z", to: "2026-09-12T08:30:00.000Z", minutes: 20, teleport: false, failedRoutes: 1, partialRoutes: 0, queuedRoutes: 0, lines: [2, 4], routeLines: [3] },
    ]);
    expect(answer.routeFailures.rows).toMatchObject([{ recipient: "seat-a", failed: 1, lines: [3] }]);
  });

  it("joins an unreported exit to its spawn row's profile", async () => {
    const answer = await ask(WINDOW);

    expect(answer.unreportedExits.rows).toMatchObject([{ profile: "implementer", count: 1, exits: [{ name: "impl-1", line: 5, spawnEventId: 1 }] }]);
  });

  it("reports agents whose last event before --until is a prompt, with any resolution and an unreadable meta", async () => {
    const answer = await ask(WINDOW);

    expect(answer.stalePrompts.rows).toEqual([
      { agent: "rev-1", at: "2026-09-12T10:00:00.000Z", ageMin: 120, tool: "Bash", eventId: 2, resolutionEventId: null },
      { agent: "impl-1", at: "2026-09-12T10:40:00.000Z", ageMin: 80, tool: null, eventId: 5, resolutionEventId: null },
    ]);
    expect(answer.stalePrompts.resolvedRows).toEqual([{ agent: "rev-2", at: "2026-09-12T10:30:00.000Z", ageMin: 90, tool: "Edit", eventId: 3, resolutionEventId: 4 }]);
  });

  it("reads --broker-log in place of the configured path", async () => {
    const other = path.join(dir, "other.log");
    writeFileSync(other, log("09:30:00", "route", { kind: "message", from: "seat-a", to: "impl-9", delivered: false, recipients: [] }));

    const answer = await ask([...WINDOW, "--broker-log", other]);

    expect(answer.routeFailures.rows.map((r) => r.recipient)).toEqual(["impl-9"]);
  });

  it("leaves the events db and broker log byte-for-byte unchanged and writes no WAL frame", async () => {
    const before = [sha(eventsDb), sha(brokerLog)];

    await ask(WINDOW);

    expect([sha(eventsDb), sha(brokerLog)]).toEqual(before);
    expect(existsSync(`${eventsDb}-wal`) ? statSync(`${eventsDb}-wal`).size : 0).toBe(0);
  });

  it("prints each table with the field and lines it cites", async () => {
    const { code, stdout } = await cli(["insights", "liveness", ...WINDOW]);

    expect(code).toBe(0);
    expect(stdout).toContain("[darkSeats.rows[]]");
    expect(stdout).toContain("broker.log:2,broker.log:4,broker.log:3");
  });

  it("refuses a missing broker log with a data error", async () => {
    const { code, stdout } = await cli(["--json", "insights", "liveness"], { ...env, TITAN_MINER_BROKER_LOG: path.join(dir, "missing.log") });

    expect(code).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: expect.stringMatching(/broker log not found/) });
  });

  it("refuses the session filters it cannot honour", async () => {
    const { code, stdout } = await cli(["--json", "insights", "liveness", "--agent-prefix", "seat-"]);

    expect(code).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: expect.stringMatching(/--seat/) });
  });

  it("is served over HTTP but refuses a broker log path there", async () => {
    const handle = await startMiner(resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, env), { port: 0 });
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${handle.port}/rpc/insights.liveness`, { method: "POST", headers: { "content-type": "application/json", "x-titan-client": "test" }, body: JSON.stringify(body) });
    try {
      expect(await (await post({ since: "2026-09-12", until: "2026-09-13" })).json()).toMatchObject({ ok: true, data: { question: "Q8" } });
      const refused = await post({ brokerLog: brokerLog });

      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toMatch(/only on the CLI/);
    } finally {
      await handle.close();
    }
  });
});
