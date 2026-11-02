import { RoundSchema } from "@titan-design/review-schema";
import { describe, expect, it } from "vitest";
import { buildPlanRound, type PlanAsk, type PlanRoundInput } from "./plan-round.js";

const TASK = "example/TP-1";
const REPO = "example-org/example-repo";
const CI_ASK: PlanAsk = {
  gate: "ci-policy",
  scope: { ciPolicyKeys: ["other"], files: [{ path: ".github/merge-lint.json", blob: "a".repeat(40) }, { path: ".github/old.yml", blob: null }] },
  title: "The merge-lint entry",
  context: "Adds one allowlist entry.",
};
const SKILL_ASK: PlanAsk = { gate: "skill", scope: { paths: [".claude/skills/example/SKILL.md"] }, title: "The skill file", context: "One new skill." };
const VISUAL_ASK: PlanAsk = { gate: "visual", scope: { paths: ["packages/ui/src/Button.tsx"] }, title: "The button", context: "A new variant." };

const input = (asks: PlanAsk[], extra: Partial<PlanRoundInput> = {}): PlanRoundInput => ({ unit: "plan-example-tp-1", round: 1, task: TASK, repo: REPO, asks, ...extra });

const pickOne = (question: { kind: string; options?: string[] }) => (question.kind === "pick-one" ? question.options! : []);

describe("buildPlanRound", () => {
  it("binds one ci-policy ask to one pick-one whose approve option records the task, repo, gate and scope", () => {
    const round = buildPlanRound(input([CI_ASK]));

    const [question] = round.questions;
    expect(question).toMatchObject({ id: "q1", kind: "pick-one" });
    expect(pickOne(question!)).toEqual([`Approve this ci-policy change for ${TASK} as pinned below`, `Revise: send the plan back for ${TASK}`]);
    expect(round.planApprovals).toEqual([
      { questionId: "q1", approve: `Approve this ci-policy change for ${TASK} as pinned below`, task: TASK, repo: REPO, gate: "ci-policy", scope: CI_ASK.scope },
    ]);
  });

  it("asks ci-policy, skill and visual in three questions and three sections, with no option label shared", () => {
    const round = buildPlanRound(input([CI_ASK, SKILL_ASK, VISUAL_ASK]));

    const labels = round.questions.flatMap(pickOne);
    expect(round.sections?.map((section) => section.questionIds)).toEqual([["q1"], ["q2"], ["q3"]]);
    expect(round.planApprovals.map(({ questionId, gate }) => [questionId, gate])).toEqual([["q1", "ci-policy"], ["q2", "skill"], ["q3", "visual"]]);
    expect(new Set(labels).size).toBe(6);
  });

  it("gives a blank title and context their fallback, and appends the question id to a blanket title and a repeated label", () => {
    const round = buildPlanRound(input([{ ...SKILL_ASK, title: "  ", context: "" }, { ...SKILL_ASK, title: "LGTM" }]));

    expect(round.sections?.map(({ title, context }) => [title, context])).toEqual([
      [`The skill plan for ${TASK}`, "No further context."],
      ["LGTM (q2)", SKILL_ASK.context],
    ]);
    expect(round.planApprovals[1]!.approve).toBe(`Approve this skill change for ${TASK} as pinned below (q2)`);
    expect(pickOne(round.questions[1]!)).toContain(round.planApprovals[1]!.approve);
  });

  it("throws on an empty ask list, and returns a manifest review-schema's RoundSchema accepts", () => {
    const manifest = Object.fromEntries(Object.entries(buildPlanRound(input([CI_ASK, SKILL_ASK]))).filter(([key]) => key !== "planApprovals"));

    expect(() => buildPlanRound(input([]))).toThrow("at least one ask");
    expect(RoundSchema.safeParse(manifest).success).toBe(true);
  });

  it("carries supersedes only when it is given", () => {
    expect(buildPlanRound(input([CI_ASK], { round: 2, supersedes: ["plan-example-tp-1-r1"] }))).toMatchObject({ round: 2, supersedes: ["plan-example-tp-1-r1"] });
    expect(buildPlanRound(input([CI_ASK]))).not.toHaveProperty("supersedes");
  });
});
