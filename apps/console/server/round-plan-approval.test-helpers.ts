import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ActionOutcome, OwnerActionClient, Unreachable } from "./owner-action.js";

export const PLAN_ROUND = "plan-orbit-r1";
export const PLAN_TASK = "example/TP-1";
export const PLAN_REPO = "example-org/example-repo";
export const CI_SCOPE = { ciPolicyKeys: ["other"], files: [{ path: ".github/merge-lint.json", blob: "a".repeat(40) }, { path: ".github/old.yml", blob: null }] };
export const SKILL_SCOPE = { paths: [".claude/skills/example/SKILL.md"] };

/** The option that approves each bound question; review-schema refuses a bare "Approve" as a blanket sign-off. */
export const APPROVE = { ci: "Approve the merge-lint entry", skill: "Approve the skill file" } as const;
export const REVISE = { ci: "Revise the merge-lint entry", skill: "Revise the skill file" } as const;

const question = (id: "ci" | "skill", prompt: string) => ({
  id,
  kind: "pick-one",
  prompt,
  options: [APPROVE[id], REVISE[id]],
  required: true,
  signsOff: id,
  recommendation: { answer: APPROVE[id], rationale: "The plan names every file it changes.", confidence: 0.8, by: "fixture-agent" },
});

/** A synthetic plan round: one CI-policy question and one skill question, each bound to its plan-approval entry. */
export function planRound(): Record<string, unknown> {
  return {
    schema: "titan-review/round@2",
    unit: "plan-orbit",
    round: 1,
    storybookUrl: "http://127.0.0.1:6006",
    widths: [1280],
    variants: [],
    recommendations: "after-answer",
    sections: [
      {
        id: "plan",
        title: "Plan approval",
        deciding: "Whether the plan's policy and skill edits may merge without a merge-time gate.",
        changed: "A merge-lint entry and one skill file.",
        context: "Nothing else in the plan is asked here.",
        parts: [
          { id: "ci", label: "Merge-lint entry", proposed: "{}", lang: "json" },
          { id: "skill", label: "Skill file", proposed: "# Example", lang: "md" },
        ],
        questionIds: ["ci", "skill"],
      },
    ],
    questions: [question("ci", "Approve the merge-lint change?"), question("skill", "Approve the skill change?")],
    planApprovals: planBindings(),
  };
}

export function planBindings(): Record<string, unknown>[] {
  return [
    { questionId: "ci", approve: APPROVE.ci, task: PLAN_TASK, repo: PLAN_REPO, gate: "ci-policy", scope: CI_SCOPE },
    { questionId: "skill", approve: APPROVE.skill, task: PLAN_TASK, repo: PLAN_REPO, gate: "skill", scope: SKILL_SCOPE },
  ];
}

export interface PlanWorld {
  roundsDir: string;
  actionsDir: string;
  manifestSha256: string;
  remove: () => Promise<void>;
}

export async function planWorld(round: Record<string, unknown> = planRound()): Promise<PlanWorld> {
  const root = await mkdtemp(path.join(tmpdir(), "console-plan-approval-"));
  const roundsDir = path.join(root, "rounds");
  await mkdir(path.join(roundsDir, PLAN_ROUND), { recursive: true });
  const bytes = JSON.stringify(round);
  await writeFile(path.join(roundsDir, PLAN_ROUND, "round.json"), bytes);
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  return { roundsDir, actionsDir: path.join(root, "actions"), manifestSha256, remove: () => rm(root, { recursive: true, force: true }) };
}

/** A feedback.json some other process put in the round dir, never written by the owner's submit. */
export async function plantFeedback(world: PlanWorld, pick: string): Promise<void> {
  const feedback = { schema: "titan-review/feedback@1", unit: "plan-orbit", round: 1, manifestSha256: world.manifestSha256, submittedAt: "2026-10-28T12:00:00.000Z", answers: [{ questionId: "ci", pick }], variants: [], general: "" };
  await writeFile(path.join(world.roundsDir, PLAN_ROUND, "feedback.json"), JSON.stringify(feedback));
}

export interface FakeFactory {
  client: OwnerActionClient;
  /** Each action id the console posted, in order. */
  posts: string[];
  /** The plan-approval actions the fake recorded, one per distinct record, as the factory keys rows on the record's sha256. */
  rows: unknown[];
  down: boolean;
}

const postedRecord = z.object({ action: z.looseObject({ task: z.string(), gate: z.string() }) });

/** Stands in for the factory's console-action route: it reads the record the id names and writes one row per distinct record. */
export function fakeFactory(actionsDir: string): FakeFactory {
  const seen = new Set<string>();
  const fake: FakeFactory = {
    posts: [],
    rows: [],
    down: false,
    client: {
      async post(actionId): Promise<ActionOutcome | Unreachable> {
        fake.posts.push(actionId);
        if (fake.down) return { status: "unreachable", detail: "factory down" };
        const bytes = await readFile(path.join(actionsDir, `${actionId}.json`));
        const confirmEvent = createHash("sha256").update(bytes).digest("hex");
        const { action } = postedRecord.parse(JSON.parse(bytes.toString("utf8")));
        if (seen.has(confirmEvent)) return { status: "already", task: action.task };
        seen.add(confirmEvent);
        fake.rows.push(action);
        return { status: "plan-approved", task: action.task, gate: action.gate, claimedRun: null };
      },
    },
  };
  return fake;
}

/** The record files in the actions dir, settled outcomes left out. */
export async function recordFiles(actionsDir: string): Promise<string[]> {
  const names = await readdir(actionsDir).catch(() => []);
  return names.filter((name) => !name.endsWith(".outcome.json"));
}
