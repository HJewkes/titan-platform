import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { sendSeatDigests, type DigestInput, type SeatDigestMemory, type SeatDigestPorts, type SeatState } from "./seat-digest.js";
import type { WatchRow } from "./view-schema.js";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

const row = (extra: Partial<WatchRow> = {}): WatchRow => ({
  repo: "acme/widgets", pr: 4, branch: "feat/4", runId: "run-4", task: "demo/T-4", phase: "ci", headSha: HEAD, phaseSince: "2026-10-10T00:00:00.000Z",
  nextAction: "waiting for CI", pendingGate: null, held: null, stalled: null, outcome: null, ...extra,
});

/** A running run whose publishes at each head completed in order, each with `review` as its record's review. */
function run(...publishes: { head: string; review?: object }[]): WorkflowRun {
  const stepResults: Record<string, StepResult> = Object.fromEntries(publishes.map(({ head, review }, i) => {
    const stepId = `sh-publish-review:${head}${i === 0 ? "" : `:${i}`}`;
    const result = { headSha: head, conclusion: "failure", published: true, checkRunId: 7, checkRunUrl: "https://github.com/acme/widgets/runs/7", ...(review && { review }) };
    return [`${stepId}#0`, { stepId, iteration: 0, agentId: null, signal: null, completedAt: `2026-10-10T00:0${i + 1}:00.000Z`, data: { result } }];
  }));
  return { id: "run-4", workflowName: "shepherd-pr", params: {}, status: "running", currentStep: "ci-wait:0", stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: "2026-10-10T00:00:00.000Z", completedAt: null, error: null };
}

async function digest(inputs: DigestInput[]): Promise<string[]> {
  const sent: string[] = [];
  const ports: SeatDigestPorts = { seatLookup: () => () => "widgets-coord", send: async (_seat, text) => void sent.push(text) };
  const states = new Map<string, SeatState>();
  const memory: SeatDigestMemory = { get: (seat) => states.get(seat), set: (seat, state) => void states.set(seat, state) };
  await sendSeatDigests(inputs, ports, memory);
  return sent;
}

describe("seat digest of a review that could not be synced", () => {
  it("names a dismissal that failed after its retries at the PR's head, with the recorded reason", async () => {
    const sent = await digest([{ row: row(), run: run({ head: HEAD, review: { dismissed: [2], reviewError: "dismissing review 1 failed: HTTP 503" } }) }]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("- acme/widgets#4 Shepherd's approval at aaaaaaa is out of line with its check: dismissing review 1 failed: HTTP 503");
  });

  it("names a configured App login that clashes with a Shepherd-marked approval", async () => {
    const reviewError = "shepherd.reviewCheck.login is not the login every Shepherd-marked approval was posted as";

    const sent = await digest([{ row: row(), run: run({ head: HEAD, review: { reviewError } }) }]);

    expect(sent[0]).toContain(`- acme/widgets#4 Shepherd's approval at aaaaaaa is out of line with its check: ${reviewError}`);
  });

  it("tells nothing once a later publish at the head synced the review", async () => {
    const sent = await digest([{ row: row(), run: run({ head: HEAD, review: { reviewError: "the review read failed: HTTP 502" } }, { head: HEAD, review: { dismissed: [1] } }) }]);

    expect(sent).toEqual([]);
  });

  it("tells nothing for a failure at a head the PR has moved past", async () => {
    const sent = await digest([{ row: row(), run: run({ head: OLD, review: { reviewError: "the review read failed: HTTP 502" } }) }]);

    expect(sent).toEqual([]);
  });

  it("tells nothing when the only error is that no review App is configured", async () => {
    const sent = await digest([{ row: row(), run: run({ head: HEAD, review: { reviewError: "no shepherd.reviewCheck App is configured" } }) }]);

    expect(sent).toEqual([]);
  });
});
