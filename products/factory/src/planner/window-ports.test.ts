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

  it("names invalid JSON, a schema mismatch and a non-ISO submittedAt as separate causes", async () => {
    const root = roundsDir({ broken: "{not json", schema: JSON.stringify({ unit: "u" }), iso: feedbackAt("2026-11-08T00:00:00Z"), unanswered: undefined });

    const answers = await roundAnswers(root);

    expect(answers.map((a) => [a.id, a.submittedAt, "why" in a ? a.why : undefined])).toEqual([
      ["broken", undefined, "feedback.json is not valid JSON"],
      ["iso", "2026-11-08T00:00:00Z", undefined],
      ["schema", undefined, "feedback.json has invalid fields round, manifestSha256, submittedAt, answers"],
    ]);
  });

  it.each(["1", "Nov 8", "0", "yesterday", "", "2026-13-45T00:00:00Z", "2026-02-30T00:00:00Z", "2026-11-08T24:00:00Z"])("treats submittedAt %j as undatable", async (value) => {
    const root = roundsDir({ odd: feedbackAt(value) });

    expect(await roundAnswers(root)).toEqual([{ id: "odd", submittedAt: undefined, why: "submittedAt is not an ISO time" }]);
  });

  it("names the failing field when submittedAt is valid but another field is not", async () => {
    const bad = JSON.stringify({ unit: "u", round: "one", manifestSha256: "abc", submittedAt: "2026-11-08T00:00:00Z", answers: [] });
    const root = roundsDir({ other: bad });

    expect(await roundAnswers(root)).toEqual([{ id: "other", submittedAt: undefined, why: "feedback.json has invalid field round" }]);
  });
});
