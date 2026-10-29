import type { ArPorts } from "@titan-design/autoresearch";
import { describe, expect, it } from "vitest";
import { planDryRun } from "./plan-dry-run.js";

const signal = new AbortController().signal;
type PlanInput = Parameters<ArPorts["plan"]>[0];

const proposal = (mechanism: string, bold = false) => ({
  hypothesis: "h", mechanism, class: "accept-gate", direction: "up", targets: ["src/gate.py"],
  expectedEffect: { metric: "score", direction: "up", microSignal: "kept:up" }, testPlan: "t", bold,
});

function planner(answer: { ops: unknown; malformed?: string }) {
  const inputs: PlanInput[] = [];
  const plan: ArPorts["plan"] = async (input) => (inputs.push(input), { agent: "ar-dry-planner", mode: input.mode, usage: { usd: 0.4, retries: 0 }, ...answer });
  return { plan, inputs };
}

describe("a plan dry run", () => {
  it("spawns one round-1 planner turn on an empty digest with the run's quota, and passes ops that meet it", async () => {
    const { plan, inputs } = planner({ ops: { add: [proposal("a", true), proposal("b")] } });

    const report = await planDryRun(plan, { runId: "dry-1", minPool: 2 }, signal);

    expect(report).toEqual({ ok: true, agent: "ar-dry-planner", usd: 0.4, adds: 2, violations: [] });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ round: 1, mode: "spawn", violations: [], quota: { keptLastRound: [], minPool: 2, queuedBefore: 0 }, digest: { round: 1, evidence: [], queue: [] } });
  });

  it("fails on the quota the run would have stopped on", async () => {
    const { plan } = planner({ ops: { add: [proposal("a", true)] } });

    const report = await planDryRun(plan, { runId: "dry-1", minPool: 12 }, signal);

    expect(report).toMatchObject({ ok: false, adds: 1, violations: ["candidate pool 1 is under 12"] });
  });

  it("fails with the parse error when the answer held no JSON, and with the schema error when it is not queue ops", async () => {
    const malformed = await planDryRun(planner({ ops: {}, malformed: "[final-message] not JSON" }).plan, { runId: "dry-1", minPool: 0 }, signal);
    const misshapen = await planDryRun(planner({ ops: { add: [{ hypothesis: "h" }] } }).plan, { runId: "dry-1", minPool: 0 }, signal);

    expect(malformed).toMatchObject({ ok: false, violations: ["[final-message] not JSON"] });
    expect(misshapen).toMatchObject({ ok: false, violations: [expect.stringContaining("[ops-schema]")] });
  });
});
