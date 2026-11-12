// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey } from "@titan-design/rpc-client";
import { z } from "zod";
import { APPROVE, PLAN_REPO, PLAN_ROUND, PLAN_TASK, planRound, planWorld, type PlanWorld } from "../server/round-plan-approval.test-helpers.js";
import { getRound } from "../server/rounds.js";
import { App } from "./App.js";

let world: PlanWorld;

beforeEach(async () => {
  world = await planWorld();
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await world.remove();
});

async function renderPlanRound(): Promise<void> {
  const calls = { [snapshotKey("rounds.get", { id: PLAN_ROUND })]: successEnvelope(await getRound({ dir: world.roundsDir }, PLAN_ROUND)) };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls }), "text/html");
  window.location.hash = `#/rounds/${PLAN_ROUND}`;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
  await screen.findByTestId("round-question-ci");
}

const linesIn = (questionId: string): string[] =>
  within(within(screen.getByTestId(`round-question-${questionId}`)).getByTestId(`plan-approval-scope-${questionId}`))
    .getAllByText(/./)
    .map((line) => line.textContent);

describe("a plan round's approval scope on the round page", () => {
  it("shows the owner each bound question's gate, task, repo, CI-policy keys and pinned files beside the question", async () => {
    await renderPlanRound();

    expect(linesIn("ci")).toEqual([
      `"${APPROVE.ci}" records a ci-policy plan approval for ${PLAN_TASK} in ${PLAN_REPO}, covering only:`,
      "CI-policy weakened: other",
      `File: .github/merge-lint.json (content ${"a".repeat(12)})`,
      "File: .github/old.yml (absent at head)",
    ]);
  });

  it("shows a skill question's exact paths", async () => {
    await renderPlanRound();

    expect(linesIn("skill")).toEqual([`"${APPROVE.skill}" records a skill plan approval for ${PLAN_TASK} in ${PLAN_REPO}, covering only:`, "Path: .claude/skills/example/SKILL.md"]);
  });
});

const VALIDATE = "Approve: validate example/TP-1 as described below";

const PlanRoundShape = z.looseObject({
  sections: z.array(z.looseObject({ questionIds: z.array(z.string()), parts: z.array(z.unknown()) })),
  questions: z.array(z.unknown()),
  planApprovals: z.array(z.unknown()),
});

/** The synthetic plan round with a third question: the owner's validation of the task itself. */
function withTaskQuestion(): Record<string, unknown> {
  const round = PlanRoundShape.parse(planRound());
  round.sections[0]!.questionIds.push("task");
  round.sections[0]!.parts.push({ id: "task", label: "The task", proposed: "Done when: it ships.", lang: "md" });
  round.questions.push({ id: "task", kind: "pick-one", prompt: "Validate TP-1: A new capability?", options: [VALIDATE, "Not now: leave example/TP-1 unvalidated"], required: true, signsOff: "task", recommendation: { answer: VALIDATE, rationale: "Synthetic.", confidence: 0.8, by: "fixture-agent" } });
  round.planApprovals.push({ questionId: "task", approve: VALIDATE, task: PLAN_TASK, repo: PLAN_REPO, gate: "task", scope: { doneWhenHash: "0123abcd", reason: "new-cap", visualSignoff: true } });
  return round;
}

describe("a task validation question on the round page", () => {
  it("shows the owner that the approve pick validates the task for every PR, with its reason and visual sign-off", async () => {
    await world.remove();
    world = await planWorld(withTaskQuestion());
    await renderPlanRound();

    expect(linesIn("task")).toEqual([
      `"${VALIDATE}" records your validation of ${PLAN_TASK}, for every PR of the task, as:`,
      "Done when, as shown above (hash 0123abcd)",
      "Why it needs you: new-cap",
      "Visual sign-off at merge: yes",
    ]);
  });
});
