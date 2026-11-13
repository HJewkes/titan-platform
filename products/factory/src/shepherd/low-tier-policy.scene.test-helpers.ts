import { fakeGitHub, githubPort, type GitHubWire, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { expect, vi } from "vitest";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import type { LowTierMode } from "./g10-low-tier.js";
import { applyRegistrationHold } from "./registration-hold.js";
import { AUTO, HEAD, PR, REPO, TASK, plannedRun } from "./plan-approval.scene.test-helpers.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";
import { timelineEntries } from "./view.js";

export const WAKE_LOOP = "products/factory/src/shepherd/wake-loop.ts";
/** The live config's roles: a G10 hold sends the run to the opus seat reviewer. */
const OPUS_ROLES = { g10: "bd-reviewer", standard: "reviewer" };

export const changed = (...paths: string[]): PrFile[] => paths.map((path) => ({ path, status: "modified", additions: 10, deletions: 0 }));

interface SceneSwitches {
  /** Wraps the fake's wire, so a scene can fail one read. */
  wire?: (each: GitHubWire) => GitHubWire;
  /** `shepherd.gateReset.lowTierPolicy` at registration and at the run's reclass reads; absent leaves it unset. */
  lowTier?: LowTierMode;
}

/** The hold the register command places for `files`, read by the real registration code against its own fake. */
async function registrationHold(files: PrFile[], { wire = (each) => each, lowTier }: SceneSwitches): Promise<string> {
  const fake = fakeGitHub();
  fake.addPr({ number: PR, headSha: HEAD });
  fake.prFiles.set(PR, files);
  const db = openDatabase(":memory:");
  const base = [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11)];
  runMigrations(db, [...base, shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
  const store = new ShepherdStore(db);
  store.register({ repo: REPO, pr: PR, runId: "classify", task: TASK, implementer: "fc-synthetic", kind: "feature", policy: AUTO });
  const held = await applyRegistrationHold(githubPort(wire(fake.wire)), store, "classify", { pause: async () => undefined, ...(lowTier && { lowTier }) });
  if (held === undefined) throw new Error("registration placed no hold");
  return held;
}

export async function heldRun(files: PrFile[], switches: SceneSwitches = {}) {
  const held = await registrationHold(files, switches);
  const { lowTier } = switches;
  return { held, run: plannedRun({ files, policy: AUTO, reviewerLines: "", approve: () => undefined, held, roles: OPUS_ROLES, ...(lowTier && { lowTier }) }, () => undefined) };
}

type Run = ReturnType<typeof plannedRun>;

export const timeline = (run: Run) => timelineEntries(run.host.runtime.status(run.runId)!, [], run.store.get().eventsOf(run.runId));

/** The entries after the opus MERGE at the head; empty until that verdict is recorded. */
function afterMerge(run: Run) {
  const entries = timeline(run);
  const at = entries.findIndex((entry) => entry.kind === "verdict" && entry.verdict === "MERGE" && entry.headSha === HEAD);
  return at < 0 ? [] : entries.slice(at + 1);
}

/** True once the CI read after the MERGE is past, where a low-tier hold is released, or the run asks the owner instead. */
const judgedAfterMerge = (run: Run): boolean => run.approveMerge() !== undefined || afterMerge(run).some((entry) => entry.kind === "ci" && entry.headSha === HEAD && entry.conclusion === "green");

/** One opus MERGE stands at the head and the run has judged it, yet nothing merged and the hold stands. */
export async function stillHeldAfterMerge(run: Run): Promise<void> {
  await vi.waitFor(() => expect(judgedAfterMerge(run)).toBe(true), { timeout: 20_000 });
  expect(afterMerge(run)).not.toContainEqual(expect.objectContaining({ kind: "decision" }));
  expect(run.fake.effects.merge).toBe(0);
  expect(run.store.get().byRun(run.runId)?.held).toBe(true);
}
