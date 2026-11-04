import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import type { RoutedStepInput } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shepherdEventMigration } from "../shepherd/events.js";
import { MERGE_EVIDENCE_STEP, decideAutoMerge, mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidence, type MergeEvidenceInput } from "../shepherd/merge-facts.js";
import type { ShepherdDeps } from "../shepherd/phases.js";
import { reviewRoutes, type ReviewWiring } from "../shepherd/review.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "../shepherd/store.js";
import { fakeLocator } from "../test-support/fakes.js";
import { judgeOldPath, type TaskTagsPort } from "./task-tags.js";

const REPO = "acme/titan-platform";
const HEAD = fakeSha("old-path-head");
const TASK = "TP-9001";
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const OLD_PATH_FILE: PrFile = { path: "products/factory/src/shepherd/new-row.ts", status: "added" };

const input: MergeEvidenceInput = {
  runId: "run-old-path",
  repo: REPO,
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator: fakeLocator({ sourceId: "transcript-1", selector: { kind: "subrecord-text" } }) },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
};

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function milestonesDir(m1bExited: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "old-path-gate-"));
  dirs.push(dir);
  const milestones = [{ id: "M1a", exited: true }, { id: "M1b", exited: m1bExited }, { id: "M3", exited: false }];
  writeFileSync(join(dir, "milestones.json"), JSON.stringify({ milestones }));
  return dir;
}

/** An open PR at HEAD that MRG-AU-RV allows: green required contexts and a clean test merge. */
function world(files: PrFile[]): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, files);
  return fake;
}

function tagsPort(tags: string[]): TaskTagsPort & { tags: ReturnType<typeof vi.fn> } {
  return { tags: vi.fn(async () => tags) };
}

/** The evidence step, then the decide step's re-read of the stored evidence at the same head, as `policy.ts` runs it. */
async function decided(fake: FakeGitHub, port: TaskTagsPort, m1bExited: boolean) {
  const oldPath = judgeOldPath({ tags: port, exitedDir: milestonesDir(m1bExited) });
  const evidence = await mergeEvidence(githubPort(fake.wire), input, noFreezeStoreUntilTp523, { kind: "correctness", task: TASK }, undefined, { oldPath });
  return { evidence, decision: decideAutoMerge(HEAD, JSON.parse(JSON.stringify(evidence)) as MergeEvidence) };
}

describe("the old-path merge guard", () => {
  it("under an exited M1b an untagged old-path head gates as old-path-untagged and names the files and the task", async () => {
    const { evidence, decision } = await decided(world([OLD_PATH_FILE]), tagsPort(["v91"]), true);

    for (const gate of [evidence.record.decision, decision]) {
      expect(gate).toMatchObject({ outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "old-path-untagged" } });
      expect(gate.reason).toContain(OLD_PATH_FILE.path);
      expect(gate.reason).toContain(`task ${TASK}`);
    }
    expect(evidence.record.oldPath).toMatchObject({ status: "untagged", active: true, kind: "correctness", task: TASK });
  });

  it.each(["superseded-at:M3", "survives:factory"])("a head whose task carries %s decides as before, and the record names its tag", async (tag) => {
    const { evidence, decision } = await decided(world([OLD_PATH_FILE]), tagsPort([tag]), true);

    expect(decision).toMatchObject({ outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV" } });
    expect(evidence.record.oldPath).toMatchObject({ status: "carved", tag, active: true });
  });

  it("before M1b exit an untagged old-path head is recorded as advisory and decides as before", async () => {
    const fake = world([OLD_PATH_FILE]);

    const { evidence, decision } = await decided(fake, tagsPort([]), false);

    expect(decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
    expect(evidence.record.oldPath).toMatchObject({ status: "untagged", active: false, touches: [OLD_PATH_FILE.path] });
    const body = fake.comments.get(1)![0]!.body;
    expect(body.split("\n").filter((line) => line.startsWith("Old path:"))).toEqual([expect.stringMatching(/^Old path: untagged: .*\(advisory until M1b exit\)\.$/)]);
  });

  it("a head whose files are unread gates only as files-unread, and the old-path read is not called", async () => {
    const fake = world([OLD_PATH_FILE]);
    fake.prChangedFiles.set(1, 5);
    const port = tagsPort([]);

    const { evidence, decision } = await decided(fake, port, true);

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "files-unread" } });
    expect(evidence.record).not.toHaveProperty("oldPath");
    expect(port.tags).not.toHaveBeenCalled();
  });

  it("a head that touches no old path decides exactly as before and reads no task", async () => {
    const fake = world([{ path: "products/factory/src/shepherd-x/a.ts", status: "modified" }]);
    const port = tagsPort([]);

    const { evidence, decision } = await decided(fake, port, true);

    expect(decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
    expect(evidence.record.oldPath).toEqual({ status: "clear", kind: "correctness", task: TASK });
    expect(port.tags).not.toHaveBeenCalled();
    expect(fake.comments.get(1)![0]!.body).not.toContain("Old path:");
  });

  it("the evidence route judges the task and kind the run was registered with", async () => {
    const store = shepherdStoreRef();
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16)]);
    store.bind(db);
    const policy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" } as const;
    new ShepherdStore(db).register({ repo: REPO, pr: 1, runId: input.runId, task: `titan-platform/${TASK}`, implementer: "impl-a", policy, kind: "security" });
    const judge = vi.fn(judgeOldPath({ tags: tagsPort([]), exitedDir: milestonesDir(true) }));
    const deps: ShepherdDeps = { port: githubPort(world([OLD_PATH_FILE]).wire), store, now: () => 0, sleep: async () => undefined, agentChatBin: "agent-chat" };
    const route = reviewRoutes(deps, partialFake<ReviewWiring>({ oldPath: judge })).find((candidate) => candidate.match === MERGE_EVIDENCE_STEP)!;

    const outcome = await route.runner.run(partialFake<RoutedStepInput>({ prompt: JSON.stringify(input), signal: new AbortController().signal, attempt: 0, requestKey: "k" }));

    if (!outcome.ok) throw new Error(outcome.error);
    expect(judge).toHaveBeenCalledWith(REPO, [OLD_PATH_FILE], `titan-platform/${TASK}`, "security");
    const { result } = JSON.parse(outcome.output) as { result: MergeEvidence };
    expect(decideAutoMerge(HEAD, result)).toMatchObject({ outcome: "gate", rule: { rowId: "old-path-untagged" } });
  });
});
