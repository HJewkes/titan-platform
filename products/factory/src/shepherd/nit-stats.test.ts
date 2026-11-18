import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { nitStats } from "./nit-stats.js";

const iso = (day: string): string => `${day}T10:00:00.000Z`;
const CUTOFF = Date.parse("2026-11-12T00:00:00Z");

function run(id: string, day: string, result: Record<string, unknown>): WorkflowRun {
  const step = { stepId: "sh-await-verdict:x", iteration: 0, agentId: null, signal: null, completedAt: iso(day), data: { result: { kind: "verdict", ...result } } };
  return { id, workflowName: "shepherd-pr", params: { repo: "acme/widgets" }, status: "completed", currentStep: null, stepResults: { "sh-await-verdict:x": step }, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(day), completedAt: null, error: null };
}

const NIT_SECTION = "## Nits\nrename the helper please\n";
const BLOCKING = "## Blocking\nthe loop never ends here\n";
const cosmetic = { title: "Rename the helper", doneWhen: "helper renamed for wording", severity: "low" };
const real = { title: "Cache the lookup", doneWhen: "lookup cached", severity: "medium" };

describe("nitStats", () => {
  it("reports each ISO week's nit share of verdict text and its cosmetic low follow-ups", () => {
    const runs = [
      run("a", "2026-11-03", { verdict: "FIX_FIRST", text: BLOCKING + NIT_SECTION, followUps: [cosmetic, real] }),
      run("b", "2026-11-04", { verdict: "FIX_FIRST", text: BLOCKING }),
      run("c", "2026-11-10", { verdict: "FIX_FIRST", text: NIT_SECTION + "## Pre-existing\nold code\n" }),
    ];

    const { weeks } = nitStats(runs, CUTOFF);

    expect(weeks).toEqual([
      { label: "2026-W45", verdicts: 2, textChars: 107, nitChars: 33, share: 0.308, cosmeticFollowUps: 1 },
      { label: "2026-W46", verdicts: 1, textChars: 58, nitChars: 58, share: 1, cosmeticFollowUps: 0 },
    ]);
  });

  it("splits before and after the nit policy's cutoff", () => {
    const runs = [run("a", "2026-11-03", { verdict: "FIX_FIRST", text: BLOCKING + NIT_SECTION }), run("b", "2026-11-13", { verdict: "FIX_FIRST", text: BLOCKING })];

    const { policy } = nitStats(runs, CUTOFF);

    expect(policy.map((row) => [row.label, row.share])).toEqual([["before", 0.471], ["after", 0]]);
  });

  it("counts a MERGE's follow-ups though no text was kept for it", () => {
    const { weeks } = nitStats([run("a", "2026-11-03", { verdict: "MERGE", followUps: [cosmetic] })], CUTOFF);

    expect(weeks).toEqual([{ label: "2026-W45", verdicts: 0, textChars: 0, nitChars: 0, share: null, cosmeticFollowUps: 1 }]);
  });
});
