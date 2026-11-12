import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it, vi } from "vitest";
import { isoWeekRange } from "./visual-feedback-merged.js";
import type { FeedbackRound } from "./visual-feedback-round.js";
import { lastClosedWeek, visualFeedbackWeek, type FeedbackWeekDeps } from "./visual-feedback-week.js";

const REPO = "example-org/example-design";
const OTHER = "example-org/example-app";
const WEEK = "2026-W45";
const NOW = new Date("2026-11-12T09:00:00.000Z");
const ASYNC = { visualGate: "async" };
const sha = (digit: string): string => digit.repeat(40);

interface MergedRun {
  pr: number;
  repo?: string;
  mergedAt?: string;
  visualChanged?: string[];
  workflowName?: string;
  task?: string;
}

const result = (stepId: string, completedAt: string, data: unknown) => ({ stepId, iteration: 0, agentId: null, signal: null, completedAt, data });

/** A shepherd-pr run whose evidence at its head recorded `visualChanged`, then merged at `mergedAt`. */
function mergedRun({ pr, repo = REPO, mergedAt = "2026-11-04T12:00:00.000Z", visualChanged = ["src/button.css"], workflowName = "shepherd-pr", task }: MergedRun): WorkflowRun {
  const head = sha(String(pr % 10));
  const evidenceAt = new Date(Date.parse(mergedAt) - 60_000).toISOString();
  const record = visualChanged.length > 0 ? { visualChanged, visualGate: "async", visualTier: { mode: "on", judged: visualChanged, verdict: { tier: 2, reason: "rendering" } } } : { visualGate: "async" };
  const stepResults = {
    [`sh-merge-evidence:${head}`]: result(`sh-merge-evidence:${head}`, evidenceAt, { result: { record } }),
    "merge:0": result("merge:0", mergedAt, { result: { done: true, mergeSha: sha("f") } }),
  };
  const params = { repo, pr: String(pr), ...(task && { task }) };
  return JSON.parse(JSON.stringify({ id: `run-${pr}`, workflowName, params, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 1, ownerGeneration: 1, startedAt: "2026-11-02T09:00:00.000Z", completedAt: mergedAt, error: null }));
}

const deps = (runs: WorkflowRun[], extra: Partial<FeedbackWeekDeps> = {}): FeedbackWeekDeps => ({ shepherd: ASYNC, runs: () => runs, now: NOW, ...extra });

async function roundOf(runs: WorkflowRun[], week = WEEK): Promise<FeedbackRound | null> {
  const sheet = await visualFeedbackWeek({ repo: REPO, week }, deps(runs));
  if (sheet.mode !== "async") throw new Error("expected the async mode");
  return sheet.round;
}

describe("the visual-week feedback batch", () => {
  it("groups one repo's PRs merged with visual changes in the week into one feedback round, lowest PR first", async () => {
    const runs = [mergedRun({ pr: 12, task: "sample/T-1" }), mergedRun({ pr: 7 }), mergedRun({ pr: 9, repo: OTHER })];

    const round = await roundOf(runs);

    expect(round).toMatchObject({ kind: "feedback", round: 1, variants: [] });
    expect(round?.sections.map((section) => section.title)).toEqual([`${REPO}#7`, `${REPO}#12`]);
    expect(round?.prGroups.map((group) => group.pr)).toEqual([`${REPO}#7`, `${REPO}#12`]);
    expect(round?.prGroups[1]).toMatchObject({ headSha: sha("2"), task: { id: "sample/T-1" }, files: [{ path: "src/button.css" }] });
  });

  it("leaves out merges outside the week, merges with no visual change and other workflows", async () => {
    const runs = [
      mergedRun({ pr: 3, mergedAt: "2026-11-09T00:00:00.000Z" }),
      mergedRun({ pr: 4, mergedAt: "2026-11-01T23:59:59.000Z" }),
      mergedRun({ pr: 5, visualChanged: [] }),
      mergedRun({ pr: 6, workflowName: "land-pr" }),
      mergedRun({ pr: 8, mergedAt: "2026-11-02T00:00:00.000Z" }),
    ];

    const round = await roundOf(runs);

    expect(round?.sections.map((section) => section.id)).toEqual(["pr-8"]);
  });

  it("asks only optional text notes, so no question binds a merge", async () => {
    const round = await roundOf([mergedRun({ pr: 7 }), mergedRun({ pr: 12 })]);

    expect(round?.questions.map((question) => question.kind)).toEqual(["text", "text"]);
    expect(round?.questions.some((question) => "merge" in question)).toBe(false);
  });

  it("builds the same bytes and unit on a re-run of the same week, and files the same round again", async () => {
    const runs = [mergedRun({ pr: 7 }), mergedRun({ pr: 12 })];
    const file = vi.fn((round: FeedbackRound) => Promise.resolve({ id: `${round.unit}-r1`, created: false }));

    const first = await visualFeedbackWeek({ repo: REPO, week: WEEK }, deps(runs, { file }));
    const second = await visualFeedbackWeek({ repo: REPO, week: WEEK }, deps(runs, { file }));

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(file.mock.calls.map(([round]) => JSON.stringify(round))).toEqual([JSON.stringify(file.mock.calls[0]![0]), JSON.stringify(file.mock.calls[0]![0])]);
  });

  it("builds no round and files nothing for a week with no visual merges", async () => {
    const file = vi.fn();

    const sheet = await visualFeedbackWeek({ repo: REPO, week: WEEK }, deps([mergedRun({ pr: 5, visualChanged: [] })], { file }));

    expect(sheet).toEqual({ mode: "async", repo: REPO, week: WEEK, round: null });
    expect(file).not.toHaveBeenCalled();
  });

  it.each([[undefined], [{}], [{ visualGate: "owner" }]])("builds no round while visualGate is not async (%j)", async (shepherd) => {
    const file = vi.fn();
    const runs = vi.fn(() => [mergedRun({ pr: 7 })]);

    const sheet = await visualFeedbackWeek({ repo: REPO, week: WEEK }, { shepherd, runs, now: NOW, file });

    expect(sheet.mode).toBe("off");
    expect(runs).not.toHaveBeenCalled();
    expect(file).not.toHaveBeenCalled();
  });

  it("refuses a week that has not ended, and defaults to the last ended week", async () => {
    await expect(visualFeedbackWeek({ repo: REPO, week: "2026-W46" }, deps([]))).rejects.toThrow(/has not ended/);
    expect(lastClosedWeek(NOW)).toBe(WEEK);
    expect(isoWeekRange(WEEK)).toEqual({ start: Date.parse("2026-11-02T00:00:00.000Z"), end: Date.parse("2026-11-09T00:00:00.000Z") });
  });

  it("keeps the unit within a round id's length and apart for two owners of one repo name", async () => {
    const long = "example-org/a-very-long-design-system-repository-name-indeed";
    const a = await visualFeedbackWeek({ repo: long, week: WEEK }, deps([mergedRun({ pr: 7, repo: long })]));
    const b = await visualFeedbackWeek({ repo: "other-org/a-very-long-design-system-repository-name-indeed", week: WEEK }, deps([mergedRun({ pr: 7, repo: "other-org/a-very-long-design-system-repository-name-indeed" })]));

    const units = [a, b].map((sheet) => (sheet.mode === "async" ? sheet.round?.unit : undefined));
    expect(new Set(units).size).toBe(2);
    expect(units.every((unit) => unit !== undefined && `${unit}-r1`.length <= 64)).toBe(true);
  });
});
