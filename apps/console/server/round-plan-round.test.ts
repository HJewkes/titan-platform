import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPlanRound, type PlanAsk } from "@titan-design/owner-queue";
import { fileRound } from "./round-file.js";
import { approvedPlans } from "./round-plan-approval.js";
import { CI_SCOPE, PLAN_REPO, PLAN_TASK, SKILL_SCOPE } from "./round-plan-approval.test-helpers.js";
import { planBindingProblems } from "./round-plan-binding.js";
import { roundRuleRefusal } from "./round-rules.js";
import { FeedbackSchema, type Manifest } from "./round-schema.js";
import { parseManifest } from "./rounds.js";

// Synthetic: owner-queue's builder output is what `titan-console decisions file -` is handed, so the console must take it as is.
const ASKS: PlanAsk[] = [
  { gate: "ci-policy", scope: CI_SCOPE, title: "The merge-lint entry", context: "Adds one allowlist entry." },
  { gate: "skill", scope: SKILL_SCOPE, title: "The skill file", context: "One new skill." },
];
const ROUND_ID = "plan-example-tp-1-r1";
const ASKER = { seat: "sample-seat", initiative: "sample-initiative" };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-plan-round-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const body = (): string => JSON.stringify(buildPlanRound({ unit: "plan-example-tp-1", round: 1, task: PLAN_TASK, repo: PLAN_REPO, asks: ASKS }));

function manifestOf(text: string): Manifest {
  const parsed = parseManifest(Buffer.from(text, "utf8"));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.manifest;
}

const feedbackPicking = (manifest: Manifest, pick: (options: readonly string[]) => string) =>
  FeedbackSchema.parse({
    schema: "titan-review/feedback@1",
    unit: manifest.unit,
    round: manifest.round,
    manifestSha256: "0".repeat(64),
    submittedAt: "2026-10-28T12:00:00.000Z",
    answers: manifest.questions.map((question) => ({ questionId: question.id, pick: pick(question.kind === "pick-one" ? question.options : []) })),
    variants: [],
    general: "",
  });

describe("a plan round built by owner-queue", () => {
  it("parses, passes the builder rules and its bindings, and files as <unit>-r<round>", async () => {
    const manifest = manifestOf(body());

    const filed = await fileRound({ body: body(), roundsDir: path.join(root, "rounds"), asker: ASKER });

    expect([roundRuleRefusal(manifest), planBindingProblems(manifest.planApprovals ?? [], manifest.questions)]).toEqual([null, []]);
    expect(filed).toMatchObject({ id: ROUND_ID, created: true });
    expect(await readdir(path.join(root, "rounds"))).toEqual([ROUND_ID]);
  });

  it("records one plan approval per approve pick, with the ask's task, repo, gate and scope, and none for Revise", () => {
    const manifest = manifestOf(body());

    const approved = approvedPlans(ROUND_ID, manifest, feedbackPicking(manifest, (options) => options[0]!));
    const revised = approvedPlans(ROUND_ID, manifest, feedbackPicking(manifest, (options) => options[1]!));

    expect(approved.map(({ record }) => (record as { action: unknown }).action)).toEqual([
      { kind: "plan-approval", task: PLAN_TASK, repo: PLAN_REPO, round: ROUND_ID, gate: "ci-policy", scope: CI_SCOPE },
      { kind: "plan-approval", task: PLAN_TASK, repo: PLAN_REPO, round: ROUND_ID, gate: "skill", scope: SKILL_SCOPE },
    ]);
    expect(revised).toEqual([]);
  });
});
