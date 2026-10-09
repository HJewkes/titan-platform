import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIST_PRICE_CAVEAT } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { resolveConfig, type MinerConfig } from "../config.js";
import { createMinerContext, type MinerContext } from "../context.js";
import { ADOPTION_OPPORTUNITIES, type AdoptionOpportunity } from "./adoption-registry.js";
import { seedBashCall, seedEventsDb, seedInsightGraph, type FixtureBashCall } from "./fixture.js";
import { patternId } from "./post-filter.js";
import type { BashCall } from "./tool-gaps-sources.js";
import { toolAdoptionQuestion, type ToolAdoptionReport } from "./tool-adoption.js";

const REGISTRY: AdoptionOpportunity[] = [
  {
    id: "ls-filter",
    task: "DEMO-1",
    pr: "demo/cli#1",
    shipped: "2026-09-01T00:00:00Z",
    old: { head: "agent-chat agent ls", patterns: ["| grep -E"] },
    new: { head: "agent-chat agent ls", flags: ["--state"] },
  },
  {
    id: "status-brief",
    task: "DEMO-2",
    pr: "demo/cli#2",
    shipped: "2026-09-01T00:00:00Z",
    old: { head: "agent-chat seats status", patterns: ["| head"] },
    new: { head: "agent-chat seats status", flags: ["--brief"] },
  },
  {
    id: "waiting-verb",
    task: "DEMO-3",
    pr: "demo/cli#3",
    shipped: "2026-09-20T00:00:00Z",
    old: { head: "titan-factory shepherd status", patterns: ["| jq -r"] },
    new: { head: "titan-factory shepherd waiting", flags: [] },
  },
];

let n = 0;
const call = (sessionId: string, ts: string, command: string | null, heads?: string): FixtureBashCall =>
  ({ toolUseId: `ta-${++n}`, sessionId, ts, outputChars: 10, command, heads });

const CALLS: FixtureBashCall[] = [
  call("impl-1", "2026-08-30T00:00:00Z", "agent-chat agent ls | grep -E running"),
  call("impl-1", "2026-09-02T00:00:00Z", "agent-chat agent ls | grep -E running"),
  call("rev-1", "2026-09-03T00:00:00Z", "agent-chat agent ls | grep -E done"),
  call("seat-1", "2026-09-04T00:00:00Z", "cd /tmp && agent-chat agent ls | grep -E impl"),
  call("seat-1", "2026-09-05T00:00:00Z", "agent-chat seats status alpha --json | head -20"),
  call("impl-1", "2026-09-16T00:00:00Z", "agent-chat agent ls --state running | grep -E impl"),
  call("rev-1", "2026-09-17T00:00:00Z", "agent-chat agent ls | grep -E running"),
  call("rev-1", "2026-09-18T00:00:00Z", "agent-chat agent ls | grep -E stale"),
  call("seat-1", "2026-09-21T00:00:00Z", "titan-factory shepherd waiting --json"),
  call("seat-1", "2026-09-22T00:00:00Z", null),
  call("impl-1", "2026-09-23T00:00:00Z", "git log | head", "git log;head"),
];

let dir: string;
let config: MinerConfig;
let ctx: MinerContext;
let db: Db;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-tool-adoption-"));
  config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), []) });
  ctx = createMinerContext(config);
  db = ctx.graph().db;
  seedInsightGraph(db);
  for (const c of CALLS) seedBashCall(db, c);
});
afterAll(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

function fakePorts(read: string[] = []) {
  const commands = new Map(CALLS.map((c) => [c.toolUseId, c.command]));
  return {
    command: async (c: BashCall) => (read.push(c.toolUseId), commands.get(c.toolUseId) ?? null),
    now: () => new Date("2026-09-25T00:00:00Z"),
  };
}

async function answer(report: { since?: string; until?: string; scope?: Record<string, unknown> } = {}, ports = fakePorts()) {
  return toolAdoptionQuestion(ports, REGISTRY).answer(db, { scope: {}, ...report }, {}, config);
}

const row = (data: ToolAdoptionReport, id: string) => data.opportunities.find((o) => o.id === id)!;

describe("tool-adoption (Q10)", () => {
  it("counts new-form and old-pattern uses per week since ship, ignoring uses before it", async () => {
    const { data } = await answer();

    expect(row(data, "ls-filter")).toMatchObject({
      newForm: "agent-chat agent ls --state",
      oldPatterns: [{ pattern: "| grep -E", patternId: patternId("| grep -E") }],
      newUses: 1,
      oldUses: 5,
      weeks: [
        { week: 1, start: "2026-09-01", newUses: 0, oldUses: 3 },
        { week: 2, start: "2026-09-08", newUses: 0, oldUses: 0 },
        { week: 3, start: "2026-09-15", newUses: 1, oldUses: 2 },
        { week: 4, start: "2026-09-22", newUses: 0, oldUses: 0 },
      ],
    });
  });

  it("counts a call that passes the new flag as the new form even when it still pipes through the old filter", async () => {
    const { data } = await answer({ since: "2026-09-15T00:00:00Z" });

    expect(row(data, "ls-filter")).toMatchObject({ newUses: 1, oldUses: 2 });
  });

  it("flags unadopted when the old pattern still outnumbers the new form two weeks after ship", async () => {
    const { data } = await answer();

    expect(row(data, "ls-filter")).toMatchObject({ daysSinceShip: 24, watching: false, flags: ["unadopted"] });
  });

  it("flags unused when nobody ran the new form in the two weeks after ship", async () => {
    const { data } = await answer();

    expect(row(data, "status-brief")).toMatchObject({ newUses: 0, oldUses: 1, flags: ["unused"] });
  });

  it("only watches an opportunity shipped under two weeks ago, and counts a new verb by its head alone", async () => {
    const { data } = await answer();

    expect(row(data, "waiting-verb")).toMatchObject({ newForm: "titan-factory shepherd waiting", newUses: 1, oldUses: 0, watching: true, flags: [] });
  });

  it("judges the opportunity as of --until, not today", async () => {
    const { data } = await answer({ until: "2026-09-10T00:00:00Z" });

    expect(data.window).toEqual({ since: "2026-09-01T00:00:00Z", until: "2026-09-10T00:00:00Z" });
    expect(row(data, "ls-filter")).toMatchObject({ watching: true, flags: [], oldUses: 3 });
  });

  it("reports what it read and never reads back a call whose recorded heads name none of the tracked CLIs", async () => {
    const read: string[] = [];
    const { data } = await answer({}, fakePorts(read));

    expect(data.totals).toEqual({ bashCalls: 10, skippedByHeads: 1, unreadable: 1, opportunities: 3 });
    expect(read).not.toContain(CALLS.at(-1)!.toolUseId);
  });

  it("narrows by agent prefix and refuses --role", async () => {
    expect(row((await answer({ scope: { agentPrefix: "rev-" } })).data, "ls-filter")).toMatchObject({ newUses: 0, oldUses: 3 });
    await expect(answer({ scope: { roles: ["worker:implementer"] } })).rejects.toMatchObject({ code: 65 });
  });

  it("renders a markdown table with weekly new/old counts and the flags, ending with the caveat", async () => {
    const { text } = await answer();

    expect(text).toContain("| id | pr | shipped | new form | old patterns | weekly new/old | new | old | flags |");
    expect(text).toContain(`| ls-filter | demo/cli#1 | 2026-09-01 | agent-chat agent ls --state | ${patternId("| grep -E")} | 0/3 0/0 1/2 0/0 | 1 | 5 | unadopted |`);
    expect(text).toContain("| waiting-verb | demo/cli#3 | 2026-09-20 | titan-factory shepherd waiting |");
    expect(text).toContain("watching");
    expect(text.trimEnd().endsWith(LIST_PRICE_CAVEAT)).toBe(true);
  });
});

describe("tool-adoption surfaces", () => {
  it("is registered as insights tool-adoption and answers Q10 in the JSON envelope", async () => {
    const empty = resolveConfig({ stateDir: path.join(dir, "empty-state"), corpusRoot: path.join(dir, "corpus") }, {});
    let stdout = "";
    const io = { stdout: (t: string) => void (stdout += t), stderr: () => undefined, env: {} };

    const code = await runCli(["--state", empty.stateDir, "--corpus", empty.corpusRoot, "--json", "insights", "tool-adoption"], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { question: "Q10", answer: { totals: { bashCalls: 0, opportunities: ADOPTION_OPPORTUNITIES.length } } } });
  });
});

describe("the adoption registry", () => {
  it("names each opportunity once, with a merged PR, a ship time and a new form that differs from the old one", () => {
    expect(new Set(ADOPTION_OPPORTUNITIES.map((o) => o.id)).size).toBe(ADOPTION_OPPORTUNITIES.length);
    for (const o of ADOPTION_OPPORTUNITIES) {
      expect(o.pr).toMatch(/^[\w.-]+\/[\w.-]+#\d+$/);
      expect(Number.isNaN(Date.parse(o.shipped))).toBe(false);
      expect(o.old.patterns.every((p) => p.startsWith("| "))).toBe(true);
      expect(o.new.flags.length > 0 || o.new.head !== o.old.head).toBe(true);
    }
  });
});
