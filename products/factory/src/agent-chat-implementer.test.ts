import type { AgentRow } from "@titan-design/agent-dispatch";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentChatImplementerRunner, type FinalMessages } from "./agent-chat-implementer.js";
import type { SpawnRequest } from "./shepherd/agents.js";
import { SpawnDeferred } from "./shepherd/spawn-gate.js";

const HEAD = "a".repeat(40);
const REPORT = { head: HEAD, targetsCovered: ["c1"] };
const ReportSchema = z.object({ head: z.string().regex(/^[0-9a-f]{40}$/), targetsCovered: z.array(z.string()) });

function row(name: string, presence: string, generation = 1): AgentRow {
  return { name, agentId: `${name}-id`, state: presence, presence, status: presence === "exited" ? "finished" : "running", profile: "bd-implementer", surface: "headless", cwd: "/tmp/demo", sessionId: `${name}-session`, generation, transcriptPath: `/tmp/${name}.jsonl`, transcriptExists: true };
}

const fenced = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** A broker whose roster walks through the given presences, one per read, staying on the last; its gate defers the first `deferrals` asks. */
function fakeBroker(presences: string[], messages: { text: string; writtenAt: number }[], deferrals = 0) {
  const spawned: SpawnRequest[] = [];
  const resumed: { name: string; message: string }[] = [];
  const slept: number[] = [];
  const admit = () => {
    if (deferrals-- > 0) throw new SpawnDeferred("load5 50.45 is past the limit 48");
  };
  let reads = 0;
  let clock = 1_000;
  const name = "bs-demo";
  const agents = {
    roster: async () => {
      const presence = presences[Math.min(reads++, presences.length - 1)]!;
      return presence === "none" ? [] : [row(name, presence)];
    },
    spawn: async (request: SpawnRequest) => (admit(), void spawned.push(request)),
    resume: async (agent: string, message: string) => (admit(), void resumed.push({ name: agent, message })),
  };
  const final: FinalMessages = async () => messages;
  const runner = agentChatImplementerRunner({ agents, messages: final, now: () => clock, sleep: async (ms) => void (slept.push(ms), (clock += ms)), pollMs: 10, startGraceMs: 50, timeoutMs: 1_000, spawnRetry: { firstMs: 100, maxMs: 300, totalMs: 1_000 } });
  return { runner, spawned, resumed, slept, name };
}

const signal = new AbortController().signal;
const spawn = (name: string) => ({ name, profile: "bd-implementer", cwd: "/tmp/demo", brief: "build it", task: "demo/DM-1", schema: ReportSchema });

describe("the agent-chat implementer runner", () => {
  it("spawns an implementer with its role and task, waits for its exit, and returns its fenced report", async () => {
    const broker = fakeBroker(["none", "live", "live", "exited"], [{ text: fenced(REPORT), writtenAt: 1_015 }]);

    const result = await broker.runner.start(spawn(broker.name), signal);

    expect(result).toEqual({ agent: broker.name, agentId: "bs-demo-id", sessionId: "bs-demo-session", report: REPORT });
    expect(broker.spawned).toEqual([{ name: broker.name, profile: "bd-implementer", brief: "build it", cwd: "/tmp/demo", role: "implementer", task: "demo/DM-1" }]);
  });

  it("does not take a report written before the ask, so a resumed round waits for its own", async () => {
    const broker = fakeBroker(["exited", "exited", "live", "exited"], [{ text: fenced({ ...REPORT, head: "b".repeat(40) }), writtenAt: 500 }]);

    await expect(broker.runner.resume(broker.name, "fix G4", ReportSchema, signal)).rejects.toThrow(/exited with no fenced JSON report/);
    expect(broker.resumed).toEqual([{ name: broker.name, message: "fix G4" }]);
  });

  it("resumes an exited agent already holding the name instead of spawning a second one", async () => {
    const broker = fakeBroker(["exited", "live", "exited"], [{ text: fenced(REPORT), writtenAt: 1_005 }]);

    const result = await broker.runner.start(spawn(broker.name), signal);

    expect(result.report).toEqual(REPORT);
    expect(broker.spawned).toEqual([]);
    expect(broker.resumed).toEqual([{ name: broker.name, message: "build it" }]);
  });

  it("rejects a report that fails its schema, naming the field", async () => {
    const broker = fakeBroker(["none", "live", "exited"], [{ text: fenced({ head: "short", targetsCovered: [] }), writtenAt: 1_005 }]);

    await expect(broker.runner.start(spawn(broker.name), signal)).rejects.toThrow(/head: /);
  });

  it("rejects a fenced block that is not JSON rather than waiting on it", async () => {
    const broker = fakeBroker(["none", "live", "exited"], [{ text: "```json\n{head: nope}\n```", writtenAt: 1_005 }]);

    await expect(broker.runner.start(spawn(broker.name), signal)).rejects.toThrow(/does not parse/);
  });

  it("waits out a spawn-gate deferral with a doubling, capped wait, then spawns and reads the report written after admission", async () => {
    const broker = fakeBroker(["none", "live", "exited"], [{ text: fenced(REPORT), writtenAt: 1_710 }], 3);

    const result = await broker.runner.start(spawn(broker.name), signal);

    expect(result.report).toEqual(REPORT);
    expect(broker.slept.slice(0, 3)).toEqual([100, 200, 300]);
    expect(broker.spawned).toHaveLength(1);
  });

  it("waits out a deferral on a fix round's resume too", async () => {
    const broker = fakeBroker(["live", "exited"], [{ text: fenced(REPORT), writtenAt: 1_105 }], 1);

    const result = await broker.runner.resume(broker.name, "fix G4", ReportSchema, signal);

    expect(result.report).toEqual(REPORT);
    expect(broker.resumed).toEqual([{ name: broker.name, message: "fix G4" }]);
  });

  it("gives up, naming the gate's reason, once the deferrals outlast the retry bound", async () => {
    const broker = fakeBroker(["none"], [], 100);

    await expect(broker.runner.start(spawn(broker.name), signal)).rejects.toThrow("bs-demo was not admitted within 0 minutes: load5 50.45 is past the limit 48");
    expect(broker.spawned).toEqual([]);
  });

  it("gives up once the timeout passes with the agent still running", async () => {
    const broker = fakeBroker(["none", "live"], []);

    await expect(broker.runner.start(spawn(broker.name), signal)).rejects.toThrow(/sent no report within/);
  });
});
