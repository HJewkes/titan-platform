import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlannerRun } from "./inputs.js";
import { ghWindow, roundAnswers } from "./window-ports.js";

const SINCE = "2026-01-02T03:00:00.000Z";
const AFTER = "2026-01-02T03:30:00.000Z";

const RUNS_BY_STATUS: Record<string, { databaseId: number; workflowName: string; createdAt: string }[]> = {
  failure: [{ databaseId: 1, workflowName: "CI", createdAt: AFTER }],
  timed_out: [{ databaseId: 2, workflowName: "Release", createdAt: AFTER }],
  startup_failure: [{ databaseId: 3, workflowName: "Docs", createdAt: AFTER }],
  success: [{ databaseId: 4, workflowName: "CI", createdAt: AFTER }],
  cancelled: [{ databaseId: 5, workflowName: "CI", createdAt: AFTER }],
};

describe("redMainRuns", () => {
  it("counts failure, timed_out and startup_failure runs and leaves success and cancelled out", async () => {
    const statuses: string[] = [];
    const gh: PlannerRun = async (_file, args) => {
      const status = args[args.indexOf("--status") + 1] ?? "";
      statuses.push(status);
      return { code: 0, stdout: JSON.stringify(RUNS_BY_STATUS[status] ?? []), stderr: "" };
    };

    const red = await ghWindow(gh).redMainRuns("org/repo", SINCE);

    expect(red.map((r) => r.id).sort()).toEqual([1, 2, 3]);
    expect(statuses).not.toContain("success");
    expect(statuses).not.toContain("cancelled");
  });
});

it("rejects when the gh query for one conclusion exits non-zero", async () => {
  const gh: PlannerRun = async (_file, args) => {
    const status = args[args.indexOf("--status") + 1] ?? "";
    if (status === "timed_out") return { code: 1, stdout: "", stderr: "boom\n" };
    return { code: 0, stdout: JSON.stringify(RUNS_BY_STATUS[status] ?? []), stderr: "" };
  };

  await expect(ghWindow(gh).redMainRuns("org/repo", SINCE)).rejects.toThrow("exit 1: boom");
});

const feedbackAt = (submittedAt: string): string => JSON.stringify({ unit: "u", round: 1, manifestSha256: "abc", submittedAt, answers: [] });

describe("roundAnswers", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function roundsDir(feedback: Record<string, string | undefined>): string {
    const root = mkdtempSync(join(tmpdir(), "rounds-"));
    dirs.push(root);
    for (const [id, body] of Object.entries(feedback)) {
      mkdirSync(join(root, id));
      writeFileSync(join(root, id, "round.json"), "{}");
      if (body !== undefined) writeFileSync(join(root, id, "feedback.json"), body);
    }
    return root;
  }

  it("keeps a round whose feedback does not parse, with no date, so the probe can report it", async () => {
    const root = roundsDir({ broken: "{not json", unanswered: undefined });

    expect(await roundAnswers(root)).toEqual([{ id: "broken", submittedAt: undefined }]);
  });

  it("keeps a round whose submittedAt is not a valid time, so the probe cannot read it as quiet", async () => {
    const root = roundsDir({
      words: feedbackAt("yesterday"),
      empty: feedbackAt(""),
      impossible: feedbackAt("2026-13-45T00:00:00Z"),
    });

    const answers = await roundAnswers(root);

    expect(answers.map((a) => a.submittedAt)).toEqual([undefined, undefined, undefined]);
  });
});
