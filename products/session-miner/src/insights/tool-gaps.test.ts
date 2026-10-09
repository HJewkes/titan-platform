import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIST_PRICE_CAVEAT } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { resolveConfig, type MinerConfig } from "../config.js";
import { createMinerContext, type MinerContext } from "../context.js";
import { FIXTURE_WINDOW, seedBashCall, seedEventsDb, seedInsightGraph, type FixtureBashCall } from "./fixture.js";
import { patternId } from "./post-filter.js";
import { readBashCommand, type BashCall } from "./tool-gaps-sources.js";
import { toolGapsQuestion, type ToolGapsPorts, type ToolGapsReport } from "./tool-gaps.js";

const CALLS: FixtureBashCall[] = [
  { toolUseId: "tu-1", sessionId: "impl-1", ts: "2026-09-10T01:00:00Z", outputChars: 400, command: "agent-chat agent ls | grep -E running | head -5" },
  { toolUseId: "tu-2", sessionId: "rev-1", ts: "2026-09-10T01:10:00Z", outputChars: 100, command: "agent-chat agent ls --prefix rev | grep -E done | head -n 2" },
  { toolUseId: "tu-3", sessionId: "seat-1", ts: "2026-09-10T01:20:00Z", outputChars: 50, command: "gh pr view 3 --json body | jq -r .body" },
  { toolUseId: "tu-4", sessionId: "impl-1", ts: "2026-09-10T01:30:00Z", outputChars: 10, command: "git status | head" },
  { toolUseId: "tu-5", sessionId: "impl-1", ts: "2026-09-10T01:40:00Z", outputChars: 10, command: "git log | head", heads: "git log;head" },
  { toolUseId: "tu-6", sessionId: "rev-1", ts: "2026-09-12T01:00:00Z", outputChars: 10, command: "agent-chat agent ls | head" },
  { toolUseId: "tu-7", sessionId: "impl-1", ts: "2026-09-10T01:50:00Z", outputChars: 10, command: null },
  { toolUseId: "tu-8", sessionId: "seat-1", ts: "2026-09-10T02:00:00Z", outputChars: 70, command: "titan-factory shepherd status | tail -3" },
  { toolUseId: "tu-9", sessionId: "rev-1", ts: "2026-09-10T02:10:00Z", outputChars: 30, command: "active-work task list demo | grep TP-1" },
];

const HELP: Record<string, string> = {
  "agent-chat agent ls": "Usage: agent-chat agent ls [options]\n  --spawner <name>  only agents it spawned\n  --prefix <p>      name prefix\n  --json",
  "gh pr view": "FLAGS\n  -q, --jq expression   Filter JSON output using a jq expression\n  --json fields",
  "titan-factory shepherd status": "Usage: titan-factory shepherd status [target]\n  --json  print JSON",
};

let dir: string;
let config: MinerConfig;
let ctx: MinerContext;
let db: Db;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-tool-gaps-"));
  config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), []) });
  ctx = createMinerContext(config);
  db = ctx.graph().db;
  seedInsightGraph(db);
  for (const call of CALLS) seedBashCall(db, call);
});
afterAll(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Recorded {
  commandsRead: string[];
  helpAsked: string[];
}

function fakePorts(): Recorded & { ports: ToolGapsPorts } {
  const recorded: Recorded = { commandsRead: [], helpAsked: [] };
  const commands = new Map(CALLS.map((c) => [c.toolUseId, c.command]));
  const ports = {
    command: async (call: BashCall) => (recorded.commandsRead.push(call.toolUseId), commands.get(call.toolUseId) ?? null),
    help: async (argv: readonly string[]) => (recorded.helpAsked.push(argv.join(" ")), HELP[argv.join(" ")] ?? null),
  };
  return { ...recorded, ports };
}

async function answer(scope: Record<string, unknown> = {}, options: { top?: number } = {}, ports = fakePorts().ports) {
  const report = { since: "2026-09-10T00:00:00.000Z", until: "2026-09-11T00:00:00.000Z", scope };
  return toolGapsQuestion(ports).answer(db, report, options, config);
}

const row = (data: ToolGapsReport, head: string) => data.patterns.find((p) => p.head === head);

describe("tool-gaps (Q9)", () => {
  it("groups pipelines headed by our CLIs by normalised post-filter, with counts, sessions, agents and output", async () => {
    const { data } = await answer();

    expect(row(data, "agent-chat agent ls")).toEqual({
      patternId: patternId("| grep -E | head"),
      head: "agent-chat agent ls",
      pattern: "| grep -E | head",
      stages: ["grep -E", "head"],
      calls: 2,
      sessions: 2,
      agents: 2,
      outputChars: 500,
      status: "EXISTS-UNUSED",
      existingFlags: ["--prefix"],
    });
    expect(data.patterns.map((p) => p.calls)).toEqual([2, 1, 1, 1]);
  });

  it("marks a filter NEW when the CLI's help names no flag that does its job, and UNKNOWN when there is no help", async () => {
    const { data } = await answer();

    expect(row(data, "gh pr view")).toMatchObject({ pattern: "| jq -r", status: "EXISTS-UNUSED", existingFlags: ["--jq"] });
    expect(row(data, "titan-factory shepherd status")).toMatchObject({ pattern: "| tail", status: "NEW", existingFlags: [] });
    expect(row(data, "active-work task list")).toMatchObject({ status: "UNKNOWN", existingFlags: [] });
  });

  it("does not count a flag every call already passes as unused", async () => {
    const help: Record<string, string> = { ...HELP, "agent-chat agent ls": "  --prefix <p>\n  --state <s>" };
    const ports = { ...fakePorts().ports, help: async (argv: readonly string[]) => help[argv.join(" ")] ?? null };
    const { data } = await answer({ sessionIds: ["rev-1"] }, {}, ports);

    expect(row(data, "agent-chat agent ls")).toMatchObject({ status: "EXISTS-UNUSED", existingFlags: ["--state"] });
  });

  it("reports what it read: Bash calls in the window, unreadable ones and pipeline totals", async () => {
    const { data } = await answer();

    expect(data.totals).toEqual({ bashCalls: 8, skippedByHeads: 1, unreadable: 1, pipelines: 5, patterns: 4, sessions: 3 });
  });

  it("skips calls whose recorded heads name none of our CLIs and asks for each help text once", async () => {
    const recorded = fakePorts();
    await answer({}, {}, recorded.ports);

    expect(recorded.commandsRead).not.toContain("tu-5");
    expect(recorded.helpAsked.sort()).toEqual(["active-work task list", "agent-chat agent ls", "gh pr view", "titan-factory shepherd status"]);
  });

  it("narrows by session and agent prefix", async () => {
    expect((await answer({ sessionIds: ["seat-1"] })).data.patterns.map((p) => p.head).sort()).toEqual(["gh pr view", "titan-factory shepherd status"]);
    expect((await answer({ agentPrefix: "rev-" })).data.totals.pipelines).toBe(2);
  });

  it("refuses --role, which needs the cost report's session tagging", async () => {
    await expect(answer({ roles: ["worker:implementer"] })).rejects.toMatchObject({ code: 65 });
  });

  it("keeps the top patterns by calls and still counts them all", async () => {
    const { data } = await answer({}, { top: 1 });

    expect(data.patterns).toHaveLength(1);
    expect(data.totals.patterns).toBe(4);
  });

  it("renders a markdown table that escapes the pipes and ends with the caveat", async () => {
    const { text } = await answer();

    expect(text).toContain("| id | head | pattern | calls | sessions | agents | output chars | status | existing flags |");
    expect(text).toContain(`| ${patternId("| grep -E | head")} | agent-chat agent ls | \\| grep -E \\| head | 2 | 2 | 2 | 500 | EXISTS-UNUSED | --prefix |`);
    expect(text.trimEnd().endsWith(LIST_PRICE_CAVEAT)).toBe(true);
  });
});

describe("tool-gaps surfaces", () => {
  it("is registered as insights tool-gaps and answers Q9 in the JSON envelope", async () => {
    const empty = resolveConfig({ stateDir: path.join(dir, "empty-state"), corpusRoot: path.join(dir, "corpus") }, {});
    let stdout = "";
    const io = { stdout: (t: string) => void (stdout += t), stderr: () => undefined, env: {} };

    const code = await runCli(["--state", empty.stateDir, "--corpus", empty.corpusRoot, "--json", "insights", "tool-gaps", "--since", FIXTURE_WINDOW.since], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { question: "Q9", answer: { totals: { bashCalls: 0 }, patterns: [] } } });
  });
});

describe("readBashCommand", () => {
  it("reads a Bash call's command back from its transcript line", async () => {
    const file = path.join(dir, "t.jsonl");
    const first = `${JSON.stringify({ type: "user" })}\n`;
    const line = JSON.stringify({ message: { content: [{ type: "text" }, { type: "tool_use", id: "tu-x", name: "Bash", input: { command: "gh pr view 1 | head" } }] } });
    writeFileSync(file, `${first}${line}\n`);
    const call = { sessionId: "s", toolUseId: "tu-x", path: file, byteOffset: Buffer.byteLength(first), byteLength: Buffer.byteLength(line), heads: null };

    expect(await readBashCommand(call)).toBe("gh pr view 1 | head");
    expect(await readBashCommand({ ...call, toolUseId: "other" })).toBeNull();
    expect(await readBashCommand({ ...call, path: path.join(dir, "missing.jsonl") })).toBeNull();
  });

  it("expands the ~/ the graph stores source keys with", async () => {
    const line = JSON.stringify({ message: { content: [{ type: "tool_use", id: "tu-h", input: { command: "agent-chat agent ls | head" } }] } });
    writeFileSync(path.join(dir, "home.jsonl"), `${line}\n`);
    const call = { sessionId: "s", toolUseId: "tu-h", path: "~/home.jsonl", byteOffset: 0, byteLength: Buffer.byteLength(line), heads: null };

    expect(await readBashCommand(call, dir)).toBe("agent-chat agent ls | head");
  });
});
