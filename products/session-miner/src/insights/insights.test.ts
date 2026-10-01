import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIST_PRICE_CAVEAT } from "@titan-design/session-analytics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { resolveConfig, type MinerConfig } from "../config.js";
import { createMinerContext } from "../context.js";
import { TOOL_PREFIX } from "../registry.js";
import { startMiner } from "../serve.js";
import { insightResultSchema } from "./define.js";
import { FIXTURE_WINDOW, seedEventsDb, seedInsightGraph } from "./fixture.js";
import { INSIGHT_QUESTIONS, blockedFlow, cacheTtl, handoffThreshold, spendByAction, wakeEconomics } from "./questions.js";

let dir: string;
let config: MinerConfig;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-insights-"));
  env = { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), []) };
  config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, env);
  const ctx = createMinerContext(config);
  seedInsightGraph(ctx.graph().db);
  ctx.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const UTC_WINDOW = { since: "2026-09-10T00:00:00.000Z", until: "2026-09-11T00:00:00.000Z" };
const WINDOW_FLAGS = ["--since", FIXTURE_WINDOW.since, "--until", FIXTURE_WINDOW.until];

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io = { stdout: (t: string) => void (stdout += t), stderr: (t: string) => void (stderr += t), env };
  const code = await runCli(["--state", config.stateDir, "--corpus", config.corpusRoot, ...args], io);
  return { code, stdout, stderr };
}

interface Envelope {
  ok: boolean;
  data: { question: string; caveat: string; filters: Record<string, unknown>; answer: { totals: { sessions: number } } & Record<string, unknown> };
}

async function ask(name: string, flags: string[] = WINDOW_FLAGS): Promise<Envelope["data"]> {
  const { code, stdout, stderr } = await cli(["--json", "insights", name, ...flags]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const envelope = JSON.parse(stdout) as Envelope;
  expect(envelope.ok).toBe(true);
  return envelope.data;
}

const GRAPH_QUESTIONS = INSIGHT_QUESTIONS.filter((q) => q !== blockedFlow);

describe.each(GRAPH_QUESTIONS.map((q) => [q.id, q] as const))("insights question %s", (_id, question) => {
  it("answers in a JSON envelope carrying the caveat, the filters and a schema-valid answer", async () => {
    const data = await ask(question.name);

    expect(insightResultSchema(question.schema).safeParse(data).success).toBe(true);
    expect(data).toMatchObject({ question: question.id, caveat: LIST_PRICE_CAVEAT, filters: UTC_WINDOW });
    expect(data.answer.totals.sessions).toBe(3);
  });

  it("renders text that carries the list-price caveat", async () => {
    const { code, stdout } = await cli(["insights", question.name, ...WINDOW_FLAGS]);

    expect(code).toBe(0);
    expect(stdout).toContain(LIST_PRICE_CAVEAT);
    expect(stdout.trimEnd().split("\n").at(-1)).toMatch(/^Price table v\d+/);
  });

  it.each([
    ["--session, repeatable", ["--session", "impl-1", "--session", "rev-1"], 2],
    ["--agent-prefix", ["--agent-prefix", "rev-"], 1],
    ["--role", ["--role", "worker:implementer"], 1],
  ])("narrows to sessions by %s", async (_flag, flags, sessions) => {
    expect((await ask(question.name, [...WINDOW_FLAGS, ...flags])).answer.totals.sessions).toBe(sessions);
  });

  it("narrows to requests by --since and --until", async () => {
    expect((await ask(question.name, ["--since", "2026-09-10T02:30:00Z", "--until", FIXTURE_WINDOW.until])).answer.totals.sessions).toBe(1);
    expect((await ask(question.name, ["--since", FIXTURE_WINDOW.since, "--until", "2026-09-10T01:35:00Z"])).answer.totals.sessions).toBe(2);
    expect((await ask(question.name, ["--since", FIXTURE_WINDOW.since])).answer.totals.sessions).toBe(3);
  });

  it("compares an offset timestamp in UTC", async () => {
    expect((await ask(question.name, ["--since", "2026-09-10T03:00:00+02:00", "--until", FIXTURE_WINDOW.until])).answer.totals.sessions).toBe(3);
    expect((await ask(question.name, ["--since", "2026-09-10T03:45:00+02:00", "--until", FIXTURE_WINDOW.until])).answer.totals.sessions).toBe(2);
  });

  it("reads a timestamp with no zone as UTC whatever the host zone is", async () => {
    const host = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect((await ask(question.name, ["--since", "2026-09-10T00:00:00", "--until", FIXTURE_WINDOW.until])).answer.totals.sessions).toBe(3);
      expect((await ask(question.name, ["--since", "2026-09-10"])).answer.totals.sessions).toBe(3);
    } finally {
      if (host === undefined) delete process.env.TZ;
      else process.env.TZ = host;
    }
  });

  it.each([
    ["--since", "garbage"],
    ["--until", "garbage"],
    ["--until", "2026-13-45"],
  ])("refuses %s %s with a usage error", async (flag, value) => {
    const { code, stdout } = await cli(["--json", "insights", question.name, flag, value]);

    expect(code).toBe(64);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false });
  });
});

describe("question answers", () => {
  it("Q1 reports spend by action per role and honours --mechanical", async () => {
    const data = await ask(spendByAction.name, [...WINDOW_FLAGS, "--mechanical", "dispatch"]);
    const answer = data.answer as unknown as { byAction: { role: string }[]; mechanicalShare: { classes: string[]; costUsd: number } };

    expect(answer.byAction.map((r) => r.role).sort()).toEqual(["worker:coordinator", "worker:implementer", "worker:reviewer"]);
    expect(answer.mechanicalShare.classes).toEqual(["dispatch"]);
    expect(answer.mechanicalShare.costUsd).toBeGreaterThan(0);
  });

  it("Q2 prices the configured thresholds it is given and reads teleports from --broker-log", async () => {
    const log = path.join(dir, "broker.log");
    writeFileSync(log, "");

    const data = await ask(handoffThreshold.name, [...WINDOW_FLAGS, "--k", "100000", "--k", "200000", "--reviewer-prs", "4", "--broker-log", log]);
    const handoff = (data.answer as unknown as { handoffThreshold: { configuredK: number[]; reviewers: { prs: number } } }).handoffThreshold;

    expect(handoff.configuredK).toEqual([100_000, 200_000]);
    expect(handoff.reviewers.prs).toBe(4);
  });

  it("Q3 reprices each role's 1h writes at the 5m rate", async () => {
    const answer = (await ask(cacheTtl.name)).answer as unknown as { byRole: { key: string; repriceSavingUsd: number }[] };

    expect(answer.byRole.map((r) => r.key).sort()).toEqual(["worker:coordinator", "worker:implementer", "worker:reviewer"]);
    expect(answer.byRole.every((r) => r.repriceSavingUsd > 0)).toBe(true);
  });

  it("Q4 cuts the coordinator's wakes into episodes and honours --episode-role", async () => {
    const seat = (await ask(wakeEconomics.name)).answer as unknown as { wakeEpisodes: { roles: string[]; episodes: number } };
    const reviewer = (await ask(wakeEconomics.name, [...WINDOW_FLAGS, "--episode-role", "worker:reviewer"])).answer as unknown as { wakeEpisodes: { roles: string[] } };

    expect(seat.wakeEpisodes.episodes).toBe(2);
    expect(reviewer.wakeEpisodes.roles).toEqual(["worker:reviewer"]);
  });

  it("refuses an unknown action class with a usage error", async () => {
    expect((await cli(["--json", "insights", spendByAction.name, "--mechanical", "nonsense"])).code).toBe(64);
  });
});

describe("insights surfaces", () => {
  it("serves every question over MCP with the miner prefix and over HTTP", async () => {
    const handle = await startMiner(config, { port: 0 });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-titan-client": "test" };
    try {
      const tools = await (await fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: "POST", headers, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).text();
      for (const question of INSIGHT_QUESTIONS) {
        expect(tools).toContain(`"${TOOL_PREFIX}insights__${question.name}"`);
        const res = await fetch(`http://127.0.0.1:${handle.port}/rpc/insights.${question.name}`, { method: "POST", headers, body: JSON.stringify(FIXTURE_WINDOW) });
        expect(await res.json()).toMatchObject({ ok: true, data: { question: question.id, caveat: LIST_PRICE_CAVEAT } });
      }
    } finally {
      await handle.close();
    }
  });

  it.each([
    ["an unparseable date", { until: "garbage" }, /until/],
    ["an unknown key", { sessionIds: ["impl-1"] }, /sessionIds/],
    ["a broker log path", { brokerLog: "/etc/hosts" }, /only on the CLI/],
  ])("refuses %s over HTTP with 400", async (_case, body, error) => {
    const handle = await startMiner(config, { port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/rpc/insights.${handoffThreshold.name}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-titan-client": "test" },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(error);
    } finally {
      await handle.close();
    }
  });
});
