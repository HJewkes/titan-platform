import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { ReviewerAgent, ReviewerDispatch, ReviewerReader } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { reviewPhase } from "./review.js";
import { shepherdStoreRef } from "./store.js";
import type { Git, GitResult } from "./tree-carry.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const MAIN = fakeSha("main-tip");
const MERGED_TREE = fakeSha("merge-tree");

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

/** H2 is the reviewed head merged cleanly with main: its first parent is the fetched `fromHead` and its tree the merge-tree. */
function cleanMergeUpGit(): Git {
  let fromHead = "";
  return async (_dir, args) => {
    const [command] = args;
    if (command === "fetch") fromHead = args[5] ?? "";
    if (command === "rev-list") return ok(`${args.at(-1)} ${fromHead} ${MAIN}`);
    if (command === "merge-tree") return ok(`${MERGED_TREE}\n`);
    if (command === "rev-parse") return ok(MERGED_TREE);
    return ok();
  };
}

const row = (name: string, presence: ReviewerAgent["presence"] = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });

/** Every reviewer Shepherd spawns, panel member or not, says MERGE at the head it reads; `spawned` names them. */
function mergingReviewers(): { dispatch: ReviewerDispatch; reader: ReviewerReader; spawned: string[] } {
  const agents: ReviewerAgent[] = [{ ...row("coord", "live"), spawnedBy: null }, row("impl-a")];
  const spawned: string[] = [];
  const dispatch: ReviewerDispatch = { roster: async () => [...agents], spawn: async (name) => void (spawned.push(name), agents.push(row(name))), resume: async () => undefined };
  const said = (who: ReviewerAgent, head: string) => ({ agentId: who.agentId, sessionId: who.sessionId, writtenAt: 1, text: `Verdict: MERGE\nPR: ${REPO}#1\nHead: ${head}\n`, locator: partialFake<SourceTextLocator>({ source: partialFake<SourceTextLocator["source"]>({ conversation: partialFake<SourceTextLocator["source"]["conversation"]>({ nativeId: who.sessionId }) }) }) });
  const reader: ReviewerReader = { read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).map((who) => said(who, input.head)) };
  return { dispatch, reader, spawned };
}

/** A correctness PR, never G10-held, whose H1 is behind main; Shepherd's update-branch makes H2, H1 plus a clean merge of main. */
function behindRun(panel: "on" | "off") {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge"), mergeableState: "behind", behind: true });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    if (pr.headSha !== H1) pr.mergeableState = "clean";
  };
  const reviewers = mergingReviewers();
  const carry = { stateDir: mkdtempSync(join(tmpdir(), "panel-carry-")), git: cleanMergeUpGit() };
  const wake: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "no fixer in this test" });
  const ref = shepherdStoreRef();
  const review = { dispatch: reviewers.dispatch, reader: reviewers.reader, roles: { g10: "bd-reviewer", standard: "bd-reviewer" }, carry, panel };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  ref.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY, kind: "correctness" });
  return { host, fake, runId, spawned: reviewers.spawned };
}

type Run = ReturnType<typeof behindRun>;
const stepIds = (w: Run): string[] => Object.values(w.host.runtime.status(w.runId)!.stepResults).map((result) => result.stepId);
const h2 = (w: Run): string => w.fake.pr(1).headSha;

describe("a panel MERGE at a reviewed head followed by Shepherd's clean merge-up of main", () => {
  it.each(["off", "on"] as const)("with review.panel %s, carries H1's MERGE to H2 with no fresh review", async (panel) => {
    const w = behindRun(panel);

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(stepIds(w).includes(`sh-review-panel:${H1}`)).toBe(panel === "on");
    expect(stepIds(w)).toEqual(expect.arrayContaining([`sh-carry:${h2(w)}`, `sh-carry-seat:${h2(w)}`, `sh-merge-up:${h2(w)}`]));
    expect(stepIds(w)).not.toContain(`sh-review-intent:${h2(w)}`);
    expect(w.spawned.every((name) => name.startsWith("rv-octo-demo-1"))).toBe(true);
    expect(w.spawned).toHaveLength(panel === "on" ? 3 : 1);
  });
});
