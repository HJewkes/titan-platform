// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey } from "@titan-design/rpc-client";
import { APPROVE, PLAN_REPO, PLAN_ROUND, PLAN_TASK, planWorld, type PlanWorld } from "../server/round-plan-approval.test-helpers.js";
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
