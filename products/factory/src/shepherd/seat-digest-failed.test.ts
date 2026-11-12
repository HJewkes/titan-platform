import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { digestReads, sendSeatDigests, type DigestInput, type SeatDigestMemory, type SeatDigestPorts, type SeatState } from "./seat-digest.js";
import type { WatchRow } from "./view-schema.js";

const SEAT = "widgets-coord";
const ERROR = "[timeout] ReviewerAskTimedOut: roster unread after 5 min";

function row(n: number, runId: string, extra: Partial<WatchRow> = {}): WatchRow {
  return {
    repo: "acme/widgets", pr: n, branch: `feat/${n}`, runId, task: `demo/T-${n}`, phase: "ci", headSha: "a".repeat(40), phaseSince: "2026-10-10T00:00:00.000Z",
    nextAction: "waiting for CI", pendingGate: null, held: null, stalled: null, outcome: null, ...extra,
  };
}

function run(id: string, failure?: { step: string; error: string }): WorkflowRun {
  const status = failure ? "failed" : "running";
  const currentStep = failure ? failure.step : "ci-wait:0";
  return { id, workflowName: "shepherd-pr", params: {}, status, currentStep, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: "2026-10-10T00:00:00.000Z", completedAt: failure ? "2026-10-10T01:00:00.000Z" : null, error: failure?.error ?? null };
}

const live = (n: number, runId: string): DigestInput => ({ row: row(n, runId), run: run(runId) });
const failedAt = (n: number, runId: string, step: string): DigestInput => ({ row: row(n, runId, { phase: "failed" }), run: run(runId, { step, error: ERROR }) });
const gated = (n: number): DigestInput => ({ row: row(n, `run-${n}`, { phase: "awaiting-approval", pendingGate: { gateId: `run-${n}/approve-merge`, stepId: "approve-merge", since: "2026-10-10T00:00:00.000Z" } }), run: run(`run-${n}`) });

function harness() {
  const states = new Map<string, SeatState>();
  const memory: SeatDigestMemory = { get: (seat) => states.get(seat), set: (seat, state) => void states.set(seat, state) };
  const sent: string[] = [];
  const ports: SeatDigestPorts = { seatLookup: () => () => SEAT, send: async (_seat, text) => void sent.push(text) };
  const reads = (input: DigestInput): boolean => digestReads(memory, () => SEAT)(input.row, input.run.status !== "running");
  const sweep = (inputs: DigestInput[]) => sendSeatDigests(inputs.filter(reads), ports, memory);
  return { sent, sweep };
}

describe("seat digest failed runs", () => {
  it("a run that fails between digests appears once under Failed with step and error", async () => {
    const { sent, sweep } = harness();
    await sweep([live(1, "run-1"), gated(2)]);

    await sweep([failedAt(1, "run-1", "sh-merge-evidence:0"), gated(2)]);

    expect(sent.at(-1)).toBe([
      `Shepherd digest for ${SEAT}: 2 open, 0 newly finished.`,
      "Still open: 1 unchanged gate; `titan-factory shepherd waiting` lists them.",
      "Failed:",
      `- acme/widgets#1 failed at sh-merge-evidence:0: ${ERROR}`,
      "  re-register: titan-factory shepherd register acme/widgets#1",
    ].join("\n"));
  });

  it("a second digest without change does not repeat it", async () => {
    const { sent, sweep } = harness();
    await sweep([live(1, "run-1"), gated(2)]);
    await sweep([failedAt(1, "run-1", "sh-merge-evidence:0"), gated(2)]);
    const told = sent.length;

    await sweep([failedAt(1, "run-1", "sh-merge-evidence:0"), gated(2)]);
    expect(sent).toHaveLength(told);
    await sweep([failedAt(1, "run-1", "sh-merge-evidence:0"), gated(2), gated(3)]);

    expect(sent.at(-1)).toMatch(/^Shepherd digest for widgets-coord: 3 open,/);
    expect(sent.at(-1)).toContain("Still open: 1 failed run; `titan-factory shepherd status` lists it.");
    expect(sent.at(-1)).not.toContain("Failed:");
  });

  it("a re-registered run that later fails again is announced again", async () => {
    const { sent, sweep } = harness();
    await sweep([live(1, "run-1"), gated(2)]);
    await sweep([failedAt(1, "run-1", "sh-merge-evidence:0"), gated(2)]);
    await sweep([failedAt(1, "run-1", "sh-merge-evidence:0"), live(1, "run-1b"), gated(2)]);

    await sweep([failedAt(1, "run-1", "sh-merge-evidence:0"), failedAt(1, "run-1b", "sh-review:1"), gated(2)]);

    expect(sent.at(-1)).toMatch(/^Shepherd digest for widgets-coord: 2 open,/);
    expect(sent.at(-1)).toContain(`Failed:\n- acme/widgets#1 failed at sh-review:1: ${ERROR}`);
    expect(sent.at(-1)).not.toContain("sh-merge-evidence");
  });
});
