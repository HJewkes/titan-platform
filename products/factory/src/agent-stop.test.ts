import type { OwnerItemDeposit } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import { stopAgent } from "./agent-stop.js";

const LIVE_ROW = { name: "bs-demo", agentId: "bs-demo-id", state: "live", presence: "live", status: "running", profile: "bd-implementer", surface: "headless", cwd: "/tmp/demo", sessionId: "bs-demo-session", generation: 1, transcriptPath: "/tmp/bs-demo.jsonl", transcriptExists: true };
const REFUSED = "worktree has unpushed work";

function harness(sleep: (ms: number, signal: AbortSignal) => Promise<void>) {
  const filed: OwnerItemDeposit[] = [];
  const ports: Parameters<typeof stopAgent>[0] = {
    agents: {
      roster: async () => [LIVE_ROW],
      message: async () => undefined,
      retire: async () => { throw new Error(REFUSED); },
    },
    tellOwner: async (deposit: OwnerItemDeposit) => void filed.push(deposit),
    sleep,
    pollMs: 10,
    stopGracePolls: 2,
  };
  return { ports: ports, filed };
}

const stopOf = (stepId: string, signal: AbortSignal) => ({ name: "bs-demo", stepId, why: "spent $2.00 of its $1.00 budget", signal, observe: async () => undefined });

describe("stopping an over-budget agent", () => {
  it("files the left-running deposit once and rethrows the abort when the run is aborted during the grace", async () => {
    const abort = new Error("aborted");
    const { ports, filed } = harness(async () => { throw abort; });

    await expect(stopAgent(ports, stopOf("1", new AbortController().signal))).rejects.toBe(abort);

    expect(filed).toHaveLength(1);
    expect(filed[0]?.context).toContain(REFUSED);
  });

  it("files two deposits when one agent is left running in two different steps", async () => {
    const { ports, filed } = harness(async () => undefined);
    const signal = new AbortController().signal;

    await expect(stopAgent(ports, stopOf("1", signal))).rejects.toThrow(/still running/);
    await expect(stopAgent(ports, stopOf("2", signal))).rejects.toThrow(/still running/);

    expect(filed).toHaveLength(2);
    expect(new Set(filed.map((deposit) => deposit.depositId)).size).toBe(2);
  });
});
