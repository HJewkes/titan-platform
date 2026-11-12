import { fakeGitHub, githubPort, type GitHubWire, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import { applyRegistrationHold } from "./registration-hold.js";
import { AUTO, HEAD, PR, REPO, TASK, plannedRun } from "./plan-approval.scene.test-helpers.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";
import { timelineEntries } from "./view.js";

/**
 * TP-5403 (owner triage q28 A): a policy touch that is low tier by its paths lands on the seat opus reviewer's MERGE at its head
 * with green CI, with no owner gate. Authority, security, publish and settings touches, and a file list that cannot be read,
 * are still held for the adversary: one opus MERGE releases none of them. Each scene runs the real shepherd-pr workflow.
 */
const WAKE_LOOP = "products/factory/src/shepherd/wake-loop.ts";
/** The live config's roles: a G10 hold sends the run to the opus seat reviewer. */
const OPUS_ROLES = { g10: "bd-reviewer", standard: "reviewer" };

const changed = (...paths: string[]): PrFile[] => paths.map((path) => ({ path, status: "modified", additions: 10, deletions: 0 }));

const failingFileList = (wire: GitHubWire): GitHubWire => ({ ...wire, listPrFiles: () => Promise.reject(new Error("file list read failed")) });

/** The hold the register command places for `files`, read by the real registration code against its own fake. */
async function registrationHold(files: PrFile[], wire: (each: GitHubWire) => GitHubWire = (each) => each): Promise<string> {
  const fake = fakeGitHub();
  fake.addPr({ number: PR, headSha: HEAD });
  fake.prFiles.set(PR, files);
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
  const store = new ShepherdStore(db);
  store.register({ repo: REPO, pr: PR, runId: "classify", task: TASK, implementer: "fc-synthetic", kind: "feature", policy: AUTO });
  const held = await applyRegistrationHold(githubPort(wire(fake.wire)), store, "classify", { pause: async () => undefined });
  if (held === undefined) throw new Error("registration placed no hold");
  return held;
}

async function heldRun(files: PrFile[], wire?: (each: GitHubWire) => GitHubWire) {
  const held = await registrationHold(files, wire);
  return { held, run: plannedRun({ files, policy: AUTO, reviewerLines: "", approve: () => undefined, held, roles: OPUS_ROLES }, () => undefined) };
}

type Run = ReturnType<typeof plannedRun>;

const timeline = (run: Run) => timelineEntries(run.host.runtime.status(run.runId)!, [], run.store.get().eventsOf(run.runId));

/** The entries after the opus MERGE at the head; empty until that verdict is recorded. */
function afterMerge(run: Run) {
  const entries = timeline(run);
  const at = entries.findIndex((entry) => entry.kind === "verdict" && entry.verdict === "MERGE" && entry.headSha === HEAD);
  return at < 0 ? [] : entries.slice(at + 1);
}

/** True once the CI read after the MERGE is past, where a low-tier hold is released, or the run asks the owner instead. */
const judgedAfterMerge = (run: Run): boolean => run.approveMerge() !== undefined || afterMerge(run).some((entry) => entry.kind === "ci" && entry.headSha === HEAD && entry.conclusion === "green");

/** One opus MERGE stands at the head and the run has judged it, yet nothing merged and the hold stands. */
async function stillHeldAfterMerge(run: Run): Promise<void> {
  await vi.waitFor(() => expect(judgedAfterMerge(run)).toBe(true), { timeout: 20_000 });
  expect(afterMerge(run)).not.toContainEqual(expect.objectContaining({ kind: "decision" }));
  expect(run.fake.effects.merge).toBe(0);
  expect(run.store.get().byRun(run.runId)?.held).toBe(true);
}

describe("a low-tier policy touch", () => {
  it("merges on the seat opus MERGE at its head with green CI and no approve-merge gate", async () => {
    const { held, run } = await heldRun(changed(WAKE_LOOP));

    await vi.waitFor(() => expect(run.fake.effects.merge).toBe(1), { timeout: 20_000 });

    expect(held).toBe("g10-review: low-tier policy touch (hold-closure)");
    expect(run.approveMerge()).toBeUndefined();
    expect(run.host.gates.listPending()).toEqual([]);
    expect(run.store.get().eventsOf(run.runId)).toContainEqual(expect.objectContaining({ kind: "release", reason: held, actor: "shepherd", headSha: HEAD }));
    expect(timeline(run)).toContainEqual(expect.objectContaining({ kind: "decision", rule: "g10-review/low-tier", head: HEAD }));
  });
});

describe("a policy touch kept from low tier", () => {
  it("an authority touch is still held for the adversary and the owner", async () => {
    const { held, run } = await heldRun(changed(WAKE_LOOP, "packages/authority/src/evaluate.ts"));

    expect(held).toBe("g10-adversary: authority, policy touch (kept: authority touch)");
    await stillHeldAfterMerge(run);
  });

  it("a security touch is still held for the adversary and the owner", async () => {
    const { held, run } = await heldRun(changed(WAKE_LOOP, "packages/tool-guard/src/index.ts"));

    expect(held).toBe("g10-adversary: policy, security touch (kept: security touch)");
    await stillHeldAfterMerge(run);
  });

  it("a publish touch is still held for the adversary and the owner", async () => {
    const { held, run } = await heldRun(changed("products/factory/src/shepherd/version-packages.ts"));

    expect(held).toBe("g10-adversary: policy touch (kept: high: publish file products/factory/src/shepherd/version-packages.ts)");
    await stillHeldAfterMerge(run);
  });

  it("a settings touch is still held for the adversary and the owner", async () => {
    const { held, run } = await heldRun(changed(WAKE_LOOP, ".github/merge-lint.json"));

    expect(held).toBe("g10-adversary: policy touch (kept: medium: .github path .github/merge-lint.json)");
    await stillHeldAfterMerge(run);
  });

  it("an unread file list fails closed to the adversary hold", async () => {
    const { held, run } = await heldRun(changed(WAKE_LOOP), failingFileList);

    expect(held).toBe("g10-adversary: changed files unread at registration (Error)");
    await stillHeldAfterMerge(run);
  });
});
