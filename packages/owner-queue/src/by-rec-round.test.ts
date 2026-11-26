import { describe, expect, it } from "vitest";
import { ManifestSchema, type Manifest } from "@titan-design/review-schema";
import { byRecDecision } from "./by-rec.js";
import { byRecRoundSubject } from "./by-rec-round.js";
import { byRecPolicySchema } from "./by-rec-schema.js";

const OPENED = "2026-03-01T00:00:00.000Z";
const LATER = new Date("2026-03-03T00:00:00.000Z");
const LIVE = byRecPolicySchema.parse({ schema: "titan/auto-by-rec-policy@1", mode: "live" });
const recommendation = (answer: string | number | string[]) => ({ answer, rationale: "The fixture agent prefers it.", confidence: 0.6, by: "fixture-agent" });

const RAMP = { id: "ramp", kind: "pick-one", prompt: "Which ramp?", options: ["Staged", "Single"], signsOff: "ramp", recommendation: recommendation("Staged") };
const HOLD = { id: "hold", kind: "scale", prompt: "How clear?", min: 1, max: 5, recommendation: recommendation(4) };
const PICKS = { id: "picks", kind: "pick-many", prompt: "Which stay?", options: ["a", "b"], recommendation: recommendation(["a", "b"]) };

function round(questions: readonly Record<string, unknown>[], sectionContext = "Synthetic.", recommendations = "shown"): Manifest {
  return ManifestSchema.parse({
    schema: "titan-review/round@2", unit: "kiln", round: 1, storybookUrl: "http://127.0.0.1:6006", context: "A synthetic round.", widths: [1280], variants: [], recommendations,
    sections: [{ id: "main", title: "Main", deciding: "The defaults.", changed: "Nothing.", context: sectionContext, questionIds: questions.map((question) => question.id), parts: [{ id: "ramp", label: "ramp", proposed: "ramp" }] }],
    questions,
  });
}

interface Asked {
  sectionContext?: string;
  recommendations?: string;
  planApprovalIds?: string[];
}

function decide(question: Record<string, unknown>, { sectionContext, recommendations, planApprovalIds = [] }: Asked = {}) {
  const manifest = round([question], sectionContext, recommendations);
  const asked = manifest.questions[0];
  if (asked === undefined) throw new Error("the fixture round asks no question");
  return byRecDecision(byRecRoundSubject(asked, manifest, { roundId: "kiln-r1", openedAt: OPENED, planApprovalIds }), LATER, LIVE);
}

describe("byRecRoundSubject", () => {
  it("lets a pick-one or an in-range scale recommendation through once the wait is out", () => {
    expect(decide(RAMP)).toMatchObject({ eligible: true, answer: "Staged" });
    expect(decide(HOLD)).toMatchObject({ eligible: true, answer: "4" });
  });

  it.each<[string, () => ReturnType<typeof decide>, string]>([
    ["a dollar amount only in the section context", () => decide(RAMP, { sectionContext: "This adds $400/month." }), "floor:money"],
    ["a dollar amount only in an option's detail", () => decide({ ...RAMP, optionDetails: { Staged: { detail: "Costs $5 a run." } } }), "floor:money"],
    ["a pick-many answer, which no single option list can check", () => decide(PICKS), "floor:answer-unsound"],
    ["a scale too wide to list its steps", () => decide({ ...HOLD, min: 0, max: 1000 }), "floor:answer-unsound"],
    ["a plan approval", () => decide(RAMP, { planApprovalIds: ["ramp"] }), "floor:plan-approval"],
    ["an after-answer round", () => decide(RAMP, { recommendations: "after-answer" }), "floor:blind"],
  ])("refuses %s", (_name, decision, reason) => {
    expect(decision()).toEqual({ eligible: false, reason });
  });
});
