import { type StepRoute, workflowStepRequestKey } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { defineWorkflow } from "./definition.js";
import { EVIDENCE_VERSION, evidenceRecord, traceRef } from "./evidence.js";
import { openFactoryHost } from "./host.js";

describe("evidence records", () => {
  it("carry the version, kind, the run as trace id and the step attempt as span id", () => {
    const step = { runId: "run-1", stepId: "commit", iteration: 2, attempt: 1 };

    const record = evidenceRecord("commit", step, "2026-01-01T00:00:00.000Z", { sha: "abc" });

    expect(record).toEqual({
      v: EVIDENCE_VERSION,
      kind: "commit",
      at: "2026-01-01T00:00:00.000Z",
      traceId: "run-1",
      spanId: workflowStepRequestKey("run-1", "commit", 2, 1),
      sha: "abc",
    });
  });

  it("cannot be overridden by a body that names its own trace fields", () => {
    const record = evidenceRecord("x", { runId: "r", stepId: "s", iteration: 0, attempt: 0 }, "t", { traceId: "forged", v: 9 });

    expect(record).toMatchObject({ traceId: "r", v: EVIDENCE_VERSION });
  });

  it("name the attempt that produced them, matching the span the runtime persisted for that step", async () => {
    let attempts = 0;
    const routes: StepRoute[] = [{
      match: "commit",
      onRestart: "repeat",
      runner: {
        run: async (input) => {
          attempts += 1;
          if (attempts === 1) return { ok: false, error: "transient", retryable: true };
          return { ok: true, output: JSON.stringify(evidenceRecord("commit", input, "t", {})) };
        },
      },
    }];
    const workflow = defineWorkflow({ name: "ev", steps: [{ id: "commit", kind: "dispatch" }], run: async (ctx) => void (await ctx.dispatch("commit", "c")) });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes });

    const run = await host.runtime.wait(host.runtime.start("ev"));
    host.close();

    const result = run.stepResults["commit:0"];
    const record = JSON.parse(result?.output ?? "{}") as { spanId: string };
    expect(record.spanId).toBe(traceRef({ runId: run.id, stepId: "commit", iteration: 0, attempt: 1 }).spanId);
    expect(record.spanId).toBe(result?.agentId);
  });
});
