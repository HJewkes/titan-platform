import { fakeGitHub, fakeSha, githubPort, type GitHubPort, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import { reclassUnread } from "./g10-reclass.js";
import { WAKE_LOOP, changed, heldRun, stillHeldAfterMerge } from "./low-tier-policy.scene.test-helpers.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { applyRegistrationHold } from "./registration-hold.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";

/**
 * TP-5403: `shepherd.gateReset.lowTierPolicy` ships in shadow. With the setting absent, a low-tier policy touch keeps its
 * `g10-adversary` hold and only names the review it would have had; `on` is the owner's own config edit.
 */
const REPO = "octo/demo";
const SHADOW_HOLD = "g10-adversary: policy touch (shadow: low tier hold-closure)";

interface Rig {
  port: GitHubPort;
  store: ShepherdStore;
}

function rig(files: PrFile[]): Rig {
  const db = openDatabase(":memory:");
  const base = [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11)];
  runMigrations(db, [...base, shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: fakeSha("head-1") });
  fake.prFiles.set(pr, files);
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "feature" });
  return { port: githubPort(fake.wire), store };
}

describe("the low-tier switch left unset", () => {
  it("an absent low-tier switch holds a low-tier policy touch g10-adversary with the shadow note", async () => {
    const r = rig(changed(WAKE_LOOP));

    const held = await applyRegistrationHold(r.port, r.store, "run-1");

    expect(held).toBe(SHADOW_HOLD);
    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: SHADOW_HOLD });
  });

  it("an absent low-tier switch places no g10-review hold at reclass", async () => {
    const r = rig(changed(WAKE_LOOP));
    const deps = { port: r.port, store: { get: () => r.store, bind: () => () => undefined }, now: () => 0, sleep: async () => undefined };

    const result = await reclassUnread(deps, { runId: "run-1", head: fakeSha("head-2") }, new AbortController().signal);

    expect(result).toEqual({ reclassed: false, held: SHADOW_HOLD });
    expect(r.store.eventsOf("run-1")).not.toContainEqual(expect.objectContaining({ kind: "hold", reason: expect.stringMatching(/^g10-review/) }));
  });

  it("with the switch absent, a low-tier policy touch is not released by one opus MERGE", async () => {
    const { held, run } = await heldRun(changed(WAKE_LOOP));

    expect(held).toBe(SHADOW_HOLD);
    await stillHeldAfterMerge(run);
  });
});
