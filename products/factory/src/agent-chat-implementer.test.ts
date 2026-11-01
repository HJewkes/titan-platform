import { DispatchError, type AgentRow } from "@titan-design/agent-dispatch";
import type { OwnerItemDeposit } from "@titan-design/owner-queue";
import { CodeStepFailure, type StepUsage } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentChatImplementerRunner, type FinalMessages } from "./agent-chat-implementer.js";
import type { SpawnRequest } from "./shepherd/agents.js";
import { SpawnDeferred } from "./shepherd/spawn-gate.js";
import { UNMETERED, type StepMeter } from "./step-usage.js";

const HEAD = "a".repeat(40);
const REPORT = { head: HEAD, targetsCovered: ["c1"] };
const ReportSchema = z.object({ head: z.string().regex(/^[0-9a-f]{40}$/), targetsCovered: z.array(z.string()) });

function row(name: string, presence: string, generation = 1): AgentRow {
  return { name, agentId: `${name}-id`, state: presence, presence, status: presence === "exited" ? "finished" : "running", profile: "bd-implementer", surface: "headless", cwd: "/tmp/demo", sessionId: `${name}-session`, generation, transcriptPath: `/tmp/${name}.jsonl`, transcriptExists: true };
}

const TURN_USAGE: StepUsage = { costUsd: 0.4, outputTokens: 900, peakContextTokens: 120_000 };

const fenced = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

interface BrokerOverrides {
  meter?: StepMeter;
  retire?: (name: string) => Promise<void>;
  /** An adapter with no retire at all. */
  noRetire?: boolean;
  tellOwner?: () => Promise<void>;
}

/** A broker whose roster walks through the given presences, one per read, staying on the last; its gate defers the first `deferrals` asks. */
function fakeBroker(presences: string[], messages: { text: string; writtenAt: number }[], deferrals = 0, refusal: Error = new SpawnDeferred("load5 50.45 is past the limit 48"), overrides: BrokerOverrides = {}) {
  const spawned: SpawnRequest[] = [];
  const resumed: { name: string; message: string }[] = [];
  const slept: number[] = [];
  const retired: string[] = [];
  const told: string[] = [];
  const owner: OwnerItemDeposit[] = [];
  const admit = () => {
    if (deferrals-- > 0) throw refusal;
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
    message: async (_agent: string, message: string) => void told.push(message),
    ...(!overrides.noRetire && { retire: overrides.retire ?? (async (agent: string) => void retired.push(agent)) }),
  };
  const final: FinalMessages = async () => messages;
  const runner = agentChatImplementerRunner({ agents, tellOwner: overrides.tellOwner ?? (async (deposit) => void owner.push(deposit)), messages: final, meter: overrides.meter ?? (async () => TURN_USAGE), stopGracePolls: 2, maxUnreadPolls: 3, now: () => clock, sleep: async (ms) => void (slept.push(ms), (clock += ms)), pollMs: 10, startGraceMs: 50, timeoutMs: 1_000, spawnRetry: { firstMs: 100, maxMs: 300, totalMs: 1_000 } });
  return { runner, spawned, resumed, slept, retired, told, owner, name };
}

const LIMIT_NOTICE = "Not spawned: reviewer account limit: account /synthetic/accounts/first five_hour 96% at or over ceiling 95%";
/** The fake clock reads 1 000 ms, so the next 15:30 UTC is the first one after that instant: 1970-01-01T15:30Z. */
const RESET_AT = Date.UTC(1970, 0, 1, 15, 30);

const signal = new AbortController().signal;
const spawn = (name: string) => ({ name, profile: "bd-implementer", cwd: "/tmp/demo", brief: "build it", task: "demo/DM-1", schema: ReportSchema });

describe("the agent-chat implementer runner", () => {
  it("spawns an implementer with its role and task, waits for its exit, and returns its fenced report", async () => {
    const broker = fakeBroker(["none", "live", "live", "exited"], [{ text: fenced(REPORT), writtenAt: 1_015 }]);

    const result = await broker.runner.start(spawn(broker.name), signal);

    expect(result).toEqual({ agent: broker.name, agentId: "bs-demo-id", sessionId: "bs-demo-session", report: REPORT, usage: TURN_USAGE });
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

  it("defers an account-limit refusal until the reset time it names instead of failing the step", async () => {
    const refusal = new DispatchError(`${LIMIT_NOTICE}; resets Jan 1 at 3:30pm (UTC) [1970-01-01T15:30:00.000Z]\ncode: reviewer_account_limit retryable: true`);
    const broker = fakeBroker(["none", "live", "exited"], [{ text: fenced(REPORT), writtenAt: RESET_AT + 710 }], 1, refusal);

    const result = await broker.runner.start(spawn(broker.name), signal);

    expect(result.report).toEqual(REPORT);
    expect(broker.slept[0]).toBe(RESET_AT - 1_000);
    expect(broker.spawned).toHaveLength(1);
  });

  it("backs off like a load deferral when an account-limit refusal names no reset", async () => {
    const refusal = new DispatchError(`${LIMIT_NOTICE}\ncode: reviewer_account_limit retryable: true`);
    const broker = fakeBroker(["none", "live", "exited"], [{ text: fenced(REPORT), writtenAt: 1_110 }], 1, refusal);

    const result = await broker.runner.start(spawn(broker.name), signal);

    expect(result.report).toEqual(REPORT);
    expect(broker.slept[0]).toBe(100);
  });

  it("fails on a refusal that is not an account limit or a gate deferral", async () => {
    const broker = fakeBroker(["none"], [], 1, new DispatchError("pool exhausted\ncode: pool_busy retryable: true"));

    await expect(broker.runner.start(spawn(broker.name), signal)).rejects.toThrow("pool exhausted");
  });

  it("gives up once the timeout passes with the agent still running", async () => {
    const broker = fakeBroker(["none", "live"], []);

    await expect(broker.runner.start(spawn(broker.name), signal)).rejects.toThrow(/sent no report within/);
  });

  describe("metering the turn against a live budget", () => {
    const REPORTED = [{ text: fenced(REPORT), writtenAt: 1_015 }];
    const NOT_REFUSED = new SpawnDeferred("unused");
    const budgeted = (budgetUsd: number, name = "bs-demo") => ({ ...spawn(name), turn: { budgetUsd } });
    /** A meter reading each amount in turn, staying on the last. */
    const readings = (...costs: number[]): StepMeter => {
      let reads = 0;
      return async () => ({ costUsd: costs[Math.min(reads++, costs.length - 1)]! });
    };

    it("lets a turn under its budget finish and reports what it spent", async () => {
      const broker = fakeBroker(["none", "live", "live", "exited"], REPORTED, 0, NOT_REFUSED, { meter: readings(0.1, 0.6, 0.6) });

      const result = await broker.runner.start(budgeted(1), signal);

      expect(result.usage).toEqual({ costUsd: 0.6 });
      expect(broker.retired).toEqual([]);
    });

    it("retires an agent in flight once its turn passes the budget, and the failure carries the overshoot", async () => {
      const broker = fakeBroker(["none", "live", "live", "live"], [], 0, NOT_REFUSED, { meter: readings(0.1, 1.3, 1.45) });

      const failure = broker.runner.start(budgeted(1), signal);

      await expect(failure).rejects.toBeInstanceOf(CodeStepFailure);
      await expect(failure).rejects.toMatchObject({ message: "bs-demo was retired: it spent $1.30 of its $1.00 budget", usage: { costUsd: 1.45 } });
      expect(broker.retired).toEqual([broker.name]);
    });

    it("does not retire at exactly the budget, which a slice may still spend", async () => {
      const broker = fakeBroker(["none", "live", "exited"], REPORTED, 0, NOT_REFUSED, { meter: readings(1) });

      await broker.runner.start(budgeted(1), signal);

      expect(broker.retired).toEqual([]);
    });

    it("retires an agent whose spend has no price, since the budget cannot be checked", async () => {
      const broker = fakeBroker(["none", "live"], [], 0, NOT_REFUSED, { meter: async () => UNMETERED });

      await expect(broker.runner.start(budgeted(1), signal)).rejects.toThrow(/has spend with no price/);
      expect(broker.retired).toEqual([broker.name]);
    });

    const REFUSED = "worktree has unpushed work";
    const refusing = async () => { throw new Error(REFUSED); };

    it("tells an agent whose retire is refused to stop, then retires it once the retry is accepted", async () => {
      let tries = 0;
      const retire = async () => { if (tries++ === 0) throw new Error(REFUSED); };
      const broker = fakeBroker(["none", "live"], [], 0, NOT_REFUSED, { meter: readings(2), retire });

      await expect(broker.runner.start(budgeted(1), signal)).rejects.toThrow("bs-demo was retired: it spent $2.00 of its $1.00 budget");

      expect(broker.told).toEqual(["Budget spent: bs-demo spent $2.00 of its $1.00 budget. Commit, push your branch, and stop now."]);
      expect(tries).toBe(2);
      expect(broker.owner).toEqual([]);
    });

    it("takes an agent that exits after the stop message as stopped, with its last spend as a firm figure", async () => {
      const broker = fakeBroker(["none", "live", "live", "exited"], [], 0, NOT_REFUSED, { meter: readings(2, 2.1), retire: refusing });

      const failure = broker.runner.start(budgeted(1), signal);

      await expect(failure).rejects.toThrow("bs-demo stopped when told to: it spent $2.00 of its $1.00 budget");
      await expect(failure).rejects.toHaveProperty("usage", { costUsd: 2.1 });
      expect(broker.owner).toEqual([]);
    });

    it("fails with unknown cost and files an owner item naming the agent when it never stops", async () => {
      const broker = fakeBroker(["none", "live"], [], 0, NOT_REFUSED, { meter: readings(2), retire: refusing });

      const failure = broker.runner.start(budgeted(1), signal);

      await expect(failure).rejects.toThrow(`bs-demo spent $2.00 of its $1.00 budget and is still running after a stop message; its retire was refused: ${REFUSED}; the owner inbox has it`);
      await expect(failure).rejects.toHaveProperty("usage", { costUsd: 2, costUnknown: true });
      expect(broker.owner).toHaveLength(1);
      expect(broker.owner[0]?.summary).toContain("bs-demo");
      expect(broker.owner[0]?.command).not.toContain("--force");
    });

    it("still fails the step when the owner item cannot be filed", async () => {
      const broker = fakeBroker(["none", "live"], [], 0, NOT_REFUSED, { meter: readings(2), retire: refusing, tellOwner: async () => { throw new Error("spool full"); } });

      await expect(broker.runner.start(budgeted(1), signal)).rejects.toThrow("the owner inbox item failed too: spool full");
    });

    it("goes through the stop message and the owner item on an adapter with no retire, and never claims a retire", async () => {
      const broker = fakeBroker(["none", "live"], [], 0, NOT_REFUSED, { meter: readings(2), noRetire: true });

      const failure = broker.runner.start(budgeted(1), signal);

      await expect(failure).rejects.toThrow("its retire was refused: this adapter cannot retire agents");
      await expect(failure).rejects.toHaveProperty("usage.costUnknown", true);
      expect(broker.told).toHaveLength(1);
      expect(broker.owner).toHaveLength(1);
    });

    it("meters a reattached live turn from the step's first start, not from the attach", async () => {
      const since: number[] = [];
      const meter: StepMeter = async (_row, sinceMs) => (since.push(sinceMs), { costUsd: 2 });
      const broker = fakeBroker(["live"], [], 0, NOT_REFUSED, { meter });
      const request = { ...spawn(broker.name), turn: { budgetUsd: 1, firstStartedAtMs: 400 } };

      await expect(broker.runner.start(request, signal)).rejects.toThrow("bs-demo was retired: it spent $2.00 of its $1.00 budget");

      expect(new Set(since)).toEqual(new Set([400]));
      expect(broker.spawned).toEqual([]);
    });

    it("fails closed after enough polls in a row that cannot be metered", async () => {
      const broker = fakeBroker(["none", "live"], [], 0, NOT_REFUSED, { meter: async () => { throw new Error("transcript unreadable"); } });

      await expect(broker.runner.start(budgeted(1), signal)).rejects.toThrow("bs-demo was retired: it could not be metered for 3 polls in a row, so its $1.00 budget cannot be checked");
      expect(broker.retired).toEqual([broker.name]);
    });

    it("counts a transcript that stays empty as unread too", async () => {
      const broker = fakeBroker(["none", "live"], [], 0, NOT_REFUSED, { meter: async () => undefined });

      await expect(broker.runner.start(budgeted(1), signal)).rejects.toThrow(/could not be metered for 3 polls/);
    });

    it("forgives bad reads that a good read interrupts", async () => {
      let reads = 0;
      const meter: StepMeter = async () => {
        if (++reads % 3 !== 0) throw new Error("mid-rotation");
        return { costUsd: 0.2 };
      };
      const presences = ["none", ...Array<string>(8).fill("live"), "exited"];
      const broker = fakeBroker(presences, REPORTED, 0, NOT_REFUSED, { meter });

      await broker.runner.start(budgeted(1), signal);

      expect(broker.retired).toEqual([]);
    });

    it("keeps the last good reading as an unknown-cost floor when the final read fails", async () => {
      let reads = 0;
      const meter: StepMeter = async () => {
        if (reads++ > 0) throw new Error("transcript gone");
        return { costUsd: 0.3 };
      };
      const broker = fakeBroker(["none", "live", "exited"], REPORTED, 0, NOT_REFUSED, { meter });

      const result = await broker.runner.start(budgeted(1), signal);

      expect(result.usage).toEqual({ costUsd: 0.3, costUnknown: true });
    });

    it("passes a cancelled turn's error through unmetered", async () => {
      const cancelled = new AbortController();
      cancelled.abort();
      let reads = 0;
      const broker = fakeBroker(["none", "live"], [], 0, NOT_REFUSED, { meter: async () => (reads++, TURN_USAGE) });

      const failure = await broker.runner.start(spawn(broker.name), cancelled.signal).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(CodeStepFailure);
      expect(reads).toBe(0);
    });

    it("reports a turn that never reached the roster as unmetered, without reading a meter", async () => {
      let reads = 0;
      const broker = fakeBroker(["none"], [], 0, NOT_REFUSED, { meter: async () => (reads++, TURN_USAGE) });

      await expect(broker.runner.start(spawn(broker.name), signal)).rejects.toMatchObject({ usage: UNMETERED });
      expect(reads).toBe(0);
    });

    it("keeps waiting through a poll the meter cannot read", async () => {
      let reads = 0;
      const meter: StepMeter = async () => {
        if (reads++ === 0) throw new Error("transcript mid-rotation");
        return TURN_USAGE;
      };
      const broker = fakeBroker(["none", "live", "exited"], REPORTED, 0, NOT_REFUSED, { meter });

      const result = await broker.runner.start(budgeted(1), signal);

      expect(result.usage).toEqual(TURN_USAGE);
      expect(broker.retired).toEqual([]);
    });

    it("carries the budget through a fix round's resume", async () => {
      const broker = fakeBroker(["live"], [], 0, NOT_REFUSED, { meter: readings(2) });

      await expect(broker.runner.resume(broker.name, "fix G4", ReportSchema, signal, { budgetUsd: 1 })).rejects.toThrow(/spent \$2\.00 of its \$1\.00 budget/);
    });

    it("reports a turn it could not read as unmetered, never as free", async () => {
      const broker = fakeBroker(["none", "live", "exited"], REPORTED, 0, NOT_REFUSED, { meter: async () => undefined });

      const result = await broker.runner.start(spawn(broker.name), signal);

      expect(result.usage).toEqual(UNMETERED);
    });

    it("keeps what a failed turn spent", async () => {
      const broker = fakeBroker(["none", "live", "exited"], [{ text: "no report", writtenAt: 1_015 }]);

      await expect(broker.runner.start(spawn(broker.name), signal)).rejects.toMatchObject({ usage: TURN_USAGE });
    });
  });
});
