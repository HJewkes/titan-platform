import { fakeSha } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { notDispatched } from "./not-reviewed.js";
import { MAX_NOT_STARTED_REVIEWS } from "./review-steps.js";

const TARGET = { repo: "octo/demo", pr: 1, head: fakeSha("not-started-head") };
const NOT_STARTED = { kind: "none", notStarted: true, reason: "the reviewer dispatch was refused: ReviewerBrokerBusy (still refused after 30 min)" };

/** `dispatches` review dispatches have completed at the head; the hold answers held and the wait released. */
function dispatchesAt(dispatches: number, historyNext?: string) {
  const steps: string[] = [];
  const inputs: string[] = [];
  async function dispatch<T extends Record<string, unknown>>(stepId: string, _template: string, options: DispatchOptions<T> = {}): Promise<StepResult<T>> {
    steps.push(stepId);
    inputs.push(String(options.vars?.CODE_STEP_INPUT));
    const result = stepId.startsWith("sh-no-reviewer-hold") ? { held: true, placed: true, alerted: true, reason: "held", standing: "held" } : { resumed: "released" };
    return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: options.schema?.parse({ result }) };
  }
  const iteration = (stepId: string) => (stepId === `sh-review:${TARGET.head}` ? dispatches : 0);
  const ctx = partialFake<WorkflowContext>({ runId: "run-1", dispatch, iteration, historyNext: () => historyNext });
  return { ctx, steps, inputs };
}

describe("notDispatched for a review dispatch that started no reviewer", () => {
  it("retries the review without a hold below the not-started limit", async () => {
    const { ctx, steps } = dispatchesAt(MAX_NOT_STARTED_REVIEWS - 1);

    const verdict = await notDispatched(ctx, TARGET, NOT_STARTED);

    expect(verdict).toEqual({ kind: "none", cause: "not-started" });
    expect(steps).toEqual([]);
  });

  it("holds the run as no-reviewer once the head reaches the not-started limit", async () => {
    const { ctx, steps, inputs } = dispatchesAt(MAX_NOT_STARTED_REVIEWS);

    const verdict = await notDispatched(ctx, TARGET, NOT_STARTED);

    expect(verdict).toMatchObject({ kind: "none", cause: "not-started" });
    expect(steps).toEqual([`sh-no-reviewer-hold:${TARGET.head}`, `sh-no-reviewer-wait:${TARGET.head}`]);
    expect(JSON.parse(inputs[0] ?? "{}")).toMatchObject({ refusal: `${MAX_NOT_STARTED_REVIEWS} review dispatches at this head started no reviewer; last: ${NOT_STARTED.reason}` });
  });

  it("keeps the recorded retry when a replayed record went on without a hold", async () => {
    const { ctx, steps } = dispatchesAt(MAX_NOT_STARTED_REVIEWS, `sh-review-intent:${TARGET.head}`);

    const verdict = await notDispatched(ctx, TARGET, NOT_STARTED);

    expect(verdict).toEqual({ kind: "none", cause: "not-started" });
    expect(steps).toEqual([]);
  });

  it("leaves a none that was not a not-started dispatch to its own mapping", async () => {
    const { ctx, steps } = dispatchesAt(MAX_NOT_STARTED_REVIEWS);

    const verdict = await notDispatched(ctx, TARGET, { kind: "none", reason: "superseded" });

    expect(verdict).toEqual({ kind: "none", cause: "no-verdict" });
    expect(steps).toEqual([]);
  });
});
