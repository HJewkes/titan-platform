import { FakeHttpError, fakeSha, type GitHubWire, type PrFile } from "@titan-design/github";
import { describe, it } from "vitest";
import type { FactoryHost } from "../host.js";
import type { PlanApproval } from "./plan-approval.js";
import { AUTO, byConsole, gatedAt, HEAD, merged, modified, PR, plannedRun as planned, REPO, T0, TASK, type FakeGitHub, type Row } from "./plan-approval.scene.test-helpers.js";
import type { ShepherdStoreRef } from "./store.js";

/**
 * TP-4284, owner decision 551: the owner decides WHAT at plan time, so a merge-guard row a claimed plan approval covers
 * does not ask again at merge. Each row is proven over a real shepherd-pr run: a covering console-written approval merges
 * with no approve-merge gate, while a differing approval, an agent-written one or another PR's still gates.
 */
const ROUND = "plan-round-1";
const MERGE_LINT = ".github/merge-lint.json";
const OLD_WORKFLOW = ".github/workflows/old.yml";
const PACKAGE_JSON = "package.json";
const SKILL_FILE = ".claude/skills/x/SKILL.md";
const VISUAL_FILE = "src/ui/button.tsx";
const LINT_AFTER = fakeSha("lint-after");
const PACKAGE_AFTER = fakeSha("package-after");

function seedFiles(fake: FakeGitHub): void {
  fake.files.set(`main:${MERGE_LINT}`, { content: '{ "allow": ["a"] }\n', blobSha: fakeSha("lint-before") });
  fake.files.set(`${HEAD}:${MERGE_LINT}`, { content: '{ "allow": ["a", "b"] }\n', blobSha: LINT_AFTER });
  fake.files.set(`main:${OLD_WORKFLOW}`, { content: "on: push\n", blobSha: fakeSha("old-before") });
  fake.files.set(`${HEAD}:${PACKAGE_JSON}`, { content: '{ "scripts": {} }\n', blobSha: PACKAGE_AFTER });
}

const plannedRun = (row: Row) => planned(row, seedFiles);

/** A row with the same scope but an agent's actor, as a write around the console would leave it. */
const byAgent =
  (approval: PlanApproval) =>
  (_store: ShepherdStoreRef, host: FactoryHost): void =>
    void host.db
      .prepare("INSERT INTO shepherd_plan_approval (confirm_event, task, repo, gate, scope, round, actor, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("action:agent", TASK, REPO, approval.gate, JSON.stringify(approval.scope), approval.round, "agent:fc-synthetic", new Date(T0).toISOString());

/** The console's approval, claimed first by another PR registered under the same task. */
const claimedElsewhere =
  (approval: PlanApproval) =>
  (store: ShepherdStoreRef, host: FactoryHost): void => {
    byConsole(approval)(store, host);
    store.get().register({ repo: REPO, pr: PR + 1, runId: "run-other-pr", task: TASK, implementer: "fc-synthetic", kind: "feature", policy: AUTO });
  };

const pinning = (files: { path: string; blob: string | null }[]): PlanApproval => ({ gate: "ci-policy", scope: { ciPolicyKeys: ["other"], files }, round: ROUND });
const CI_POLICY = pinning([{ path: MERGE_LINT, blob: LINT_AFTER }]);
const ciRow = (approve: Row["approve"], files = modified(MERGE_LINT)): Row => ({ files, policy: AUTO, reviewerLines: "CI-policy: weakened other\n", approve });

describe("a PR whose only guard row is ci-policy-weakened, a merge-lint entry", () => {
  it("merges with no owner gate under a console-written approval pinning that file's head blob", async () => {
    await merged(plannedRun(ciRow(byConsole(CI_POLICY))));
  });

  it("gates at the same head when the approval pins a different blob", async () => {
    await gatedAt(plannedRun(ciRow(byConsole(pinning([{ path: MERGE_LINT, blob: fakeSha("lint-other") }])))), "ci-policy-weakened");
  });

  it("gates at the same head under an agent-written approval with the right pin", async () => {
    await gatedAt(plannedRun(ciRow(byAgent(CI_POLICY))), "ci-policy-weakened");
  });

  it("gates a second PR registered later under the approved task", async () => {
    await gatedAt(plannedRun(ciRow(claimedElsewhere(CI_POLICY))), "ci-policy-weakened");
  });
});

describe("a weakened PR that merges content the approval did not pin", () => {
  it("gates a head carrying the approved merge-lint blob and an unpinned package.json change", async () => {
    await gatedAt(plannedRun(ciRow(byConsole(CI_POLICY), modified(MERGE_LINT, PACKAGE_JSON))), "ci-policy-weakened");
  });

  it("gates a weakening with no .github/ change at all", async () => {
    await gatedAt(plannedRun(ciRow(byConsole(CI_POLICY), modified(PACKAGE_JSON))), "ci-policy-weakened");
  });
});

describe("a weakened PR whose approval pins a deleted workflow as absent", () => {
  const files: PrFile[] = [...modified(MERGE_LINT), { path: OLD_WORKFLOW, status: "removed" }];
  const approval = pinning([{ path: MERGE_LINT, blob: LINT_AFTER }, { path: OLD_WORKFLOW, blob: null }]);
  const failingHeadRead = (wire: GitHubWire): GitHubWire => ({
    ...wire,
    getContent: async (repo, path, ref) => {
      if (path === OLD_WORKFLOW && ref === HEAD) throw new FakeHttpError(502, "bad gateway");
      return wire.getContent(repo, path, ref);
    },
  });

  it("merges when every head read succeeds", async () => {
    await merged(plannedRun(ciRow(byConsole(approval), files)));
  });

  it("gates when the deleted file's head read fails, rather than reading it as absent", async () => {
    await gatedAt(plannedRun({ ...ciRow(byConsole(approval), files), wire: failingHeadRead }), "ci-policy-weakened");
  });
});

const SKILL: PlanApproval = { gate: "skill", scope: { paths: [SKILL_FILE] }, round: ROUND };
const skillRow = (approve: Row["approve"]): Row => ({ files: [...modified("src/x.ts"), { path: SKILL_FILE, status: "added" }], policy: AUTO, reviewerLines: "", approve });

describe("a PR that adds a repo skill", () => {
  it("merges with no owner gate under a console-written approval of that skill path", async () => {
    await merged(plannedRun(skillRow(byConsole(SKILL))));
  });

  it("gates at the skill-path row when the approval names another skill path", async () => {
    await gatedAt(plannedRun(skillRow(byConsole({ ...SKILL, scope: { paths: [".claude/skills/y/SKILL.md"] } }))), "skill-path");
  });

  it("gates at the skill-path row under an agent-written approval of the same path", async () => {
    await gatedAt(plannedRun(skillRow(byAgent(SKILL))), "skill-path");
  });
});

const VISUAL: PlanApproval = { gate: "visual", scope: { paths: [VISUAL_FILE] }, round: ROUND };
const visualRow = (approve: Row["approve"]): Row => ({ files: modified(VISUAL_FILE), policy: { ...AUTO, visualPaths: ["src/ui/**"] }, reviewerLines: "", approve });

describe("a PR that changes a seat's visual path", () => {
  it("merges with no owner gate under a console-written approval of that path", async () => {
    await merged(plannedRun(visualRow(byConsole(VISUAL))));
  });

  it("gates at the visual-path row when the approval names another visual path", async () => {
    await gatedAt(plannedRun(visualRow(byConsole({ ...VISUAL, scope: { paths: ["src/ui/card.tsx"] } }))), "visual-path");
  });

  it("gates at the visual-path row under an agent-written approval of the same path", async () => {
    await gatedAt(plannedRun(visualRow(byAgent(VISUAL))), "visual-path");
  });
});
