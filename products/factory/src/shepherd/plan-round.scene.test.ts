import { describe, expect, it } from "vitest";
import { PlanApprovalActionSchema } from "../console-action/record.js";
import { AUTO, gatedAt, HEAD, merged, modified, plannedRun, recordedAction, REPO, TASK, type FakeGitHub, type Row } from "./plan-approval.scene.test-helpers.js";
import { planRound, PlanBlockSchema, type GitRead, type PlanBlock } from "./plan-round.js";

/**
 * TP-4360's done_when, over a real shepherd-pr run: the binding `plan-round` drafts, once the owner approves it through the
 * console, lets the PR built to the plan merge with no owner gate, and a PR that strays from the plan still gates.
 */
const MERGE_LINT = ".github/merge-lint.json";
const PACKAGE_JSON = "package.json";
const LINT = '{ "allow": ["a", "b"] }\n';
const SCRIPTS = '{ "scripts": {} }\n';
/** `git hash-object` of each content, computed outside the code under test. */
const BLOBS: Record<string, string> = {
  [LINT]: "9f0f350c61e7c894b9a66870a77c9826c796d2d4",
  '{ "allow": ["a", "c"] }\n': "c55f690feb78fd0ab527cb1bf9a94fc43902e8ad",
  [SCRIPTS]: "9065042e3669d2f2e048bac8c2cc27530ad21213",
};
const SKILL_FILE = ".claude/skills/x/SKILL.md";
const ROUND_ID = "plan-demo-tp-1-r1";
const baseless: GitRead = { show: async () => null, blob: async () => null, commit: async (ref) => ref, diffNames: async () => [] };

const plan = (fields: Pick<PlanBlock, "files"> & Partial<PlanBlock>): PlanBlock => PlanBlockSchema.parse({ task: TASK, repo: REPO, summary: "Allow b in merge-lint", ...fields });

/** Drafts the round, then records its one binding as the console does when the owner picks approve. */
async function ownerApproved(block: PlanBlock): Promise<Row["approve"]> {
  const { round } = await planRound(block, { round: 1, base: "origin/main" }, baseless);
  expect(round?.planApprovals).toHaveLength(1);
  const { task, repo, gate, scope } = round!.planApprovals[0]!;
  return recordedAction(PlanApprovalActionSchema.parse({ kind: "plan-approval", task, repo, round: ROUND_ID, gate, scope }));
}

/** The PR's head holds `contents`, each at its real git blob sha, as GitHub would report it. */
const atHead =
  (contents: Record<string, string>) =>
  (fake: FakeGitHub): void => {
    for (const [path, content] of Object.entries(contents)) fake.files.set(`${HEAD}:${path}`, { content, blobSha: BLOBS[content]! });
  };

describe("a CI-policy PR drafted with plan-round and approved at plan time", () => {
  const policyPlan = plan({ files: [{ path: MERGE_LINT, content: LINT }, { path: PACKAGE_JSON, content: SCRIPTS }], ciPolicyKeys: ["other"] });
  const row = (approve: Row["approve"]): Row => ({ files: modified(MERGE_LINT, PACKAGE_JSON), policy: AUTO, reviewerLines: "CI-policy: weakened other\n", approve });

  it("merges with no owner gate when the PR's files are exactly the plan's bytes", async () => {
    await merged(plannedRun(row(await ownerApproved(policyPlan)), atHead({ [MERGE_LINT]: LINT, [PACKAGE_JSON]: SCRIPTS })));
  });

  it("gates as an unplanned change when one byte of a pinned file differs", async () => {
    const run = plannedRun(row(await ownerApproved(policyPlan)), atHead({ [MERGE_LINT]: '{ "allow": ["a", "c"] }\n', [PACKAGE_JSON]: SCRIPTS }));

    await gatedAt(run, "ci-policy-weakened");
    expect(run.approveMerge()?.prompt).toContain(`unplanned change: the plan approval at round ${ROUND_ID} does not cover this head`);
  });
});

describe("a skill PR drafted with plan-round and approved at plan time", () => {
  const skillPlan = plan({ files: [{ path: "src/x.ts" }, { path: SKILL_FILE }] });
  const added = (paths: string[]) => paths.map((path) => ({ path, status: "added" }));
  const row = (approve: Row["approve"], skills: string[]): Row => ({ files: [...modified("src/x.ts"), ...added(skills)], policy: AUTO, reviewerLines: "", approve });

  it("merges with no owner gate when the PR adds exactly the planned skill path", async () => {
    await merged(plannedRun(row(await ownerApproved(skillPlan), [SKILL_FILE]), () => undefined));
  });

  it("gates at the skill-path row when the PR adds a skill path the plan did not name", async () => {
    await gatedAt(plannedRun(row(await ownerApproved(skillPlan), [SKILL_FILE, ".claude/skills/y/SKILL.md"]), () => undefined), "skill-path");
  });
});
