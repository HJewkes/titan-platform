import { fakeGitHub, fakeSha, githubPort, type GitHubPort, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import type { LowTierMode } from "./g10-low-tier.js";
import { reclassUnread } from "./g10-reclass.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { applyRegistrationHold } from "./registration-hold.js";
import { requiredSignoffs } from "./signoffs.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";

const REPO = "octo/demo";
const NEXT_HEAD = fakeSha("head-2");
/** In the hold closure only: the shape of a wake-loop fix. */
const HOLD_CLOSURE_PATH = "products/factory/src/shepherd/wake-loop.ts";
const AUTHORITY_PATH = "packages/authority/src/evaluate.ts";
const LOW_TIER_HOLD = "g10-review: low-tier policy touch (hold-closure)";

const file = (path: string, additions: number): PrFile => ({ path, status: "modified", additions, deletions: 0 });

interface Rig {
  port: GitHubPort;
  store: ShepherdStore;
  setFiles: (files: PrFile[]) => void;
}

function rig(files: PrFile[], visualPaths?: string[]): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: fakeSha("head-1") });
  fake.prFiles.set(pr, files);
  const policy = visualPaths === undefined ? OWNER_GATE_POLICY : { ...OWNER_GATE_POLICY, visualPaths };
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy, kind: "feature" });
  return { port: githubPort(fake.wire), store, setFiles: (next) => fake.prFiles.set(pr, next) };
}

const hold = (r: Rig, lowTier?: LowTierMode) => applyRegistrationHold(r.port, r.store, "run-1", lowTier === undefined ? {} : { lowTier });

const reclassAtNextHead = (r: Rig) =>
  reclassUnread({ port: r.port, store: { get: () => r.store, bind: () => () => undefined }, now: () => 0, sleep: async () => undefined }, { runId: "run-1", head: NEXT_HEAD }, new AbortController().signal);

describe("the low-tier policy hold at registration", () => {
  it("a low-tier policy touch is held g10-review naming its tables", async () => {
    const r = rig([file(HOLD_CLOSURE_PATH, 10)]);

    expect(await hold(r)).toBe(LOW_TIER_HOLD);
    expect(r.store.eventsOf("run-1")).toEqual([expect.objectContaining({ kind: "hold", reason: LOW_TIER_HOLD, actor: "shepherd" })]);
  });

  it("a policy touch over 800 lines is held g10-adversary", async () => {
    const r = rig([file(HOLD_CLOSURE_PATH, 900)]);

    expect(await hold(r)).toBe("g10-adversary: policy touch (kept: medium: size: 900 changed lines, over 800)");
  });

  it("a one-line edit to the adversary touches is held g10-adversary", async () => {
    const r = rig([file("products/factory/src/shepherd/signoffs.ts", 1)]);

    expect(await hold(r)).toBe("g10-adversary: policy touch (kept: gate input products/factory/src/shepherd/signoffs.ts)");
  });

  it("an edit to the review-panel class rules is held g10-adversary", async () => {
    const r = rig([file("packages/review-panel/src/classify.ts", 1)]);

    expect(await hold(r)).toBe("g10-adversary: policy touch (kept: gate input packages/review-panel/src/classify.ts)");
  });

  it("a low-tier hold over a stalled hold goes in as adversary", async () => {
    const r = rig([file(HOLD_CLOSURE_PATH, 10)]);
    r.store.hold("run-1", "stalled: no CI read");

    expect(await hold(r)).toBe("g10-adversary: low-tier policy touch (hold-closure), over a stalled hold");
  });

  it("a policy path the run's visual globs name keeps the owner gate", async () => {
    const r = rig([file(HOLD_CLOSURE_PATH, 10)], ["products/factory/src/shepherd/**"]);

    expect(await hold(r)).toBe(`g10-adversary: policy touch (kept: high: visual ${HOLD_CLOSURE_PATH})`);
  });

  it("a file with no line counts keeps the owner gate", async () => {
    const r = rig([{ path: HOLD_CLOSURE_PATH, status: "modified" }]);

    expect(await hold(r)).toBe("g10-adversary: policy touch (kept: changed lines unread)");
  });
});

describe("the low-tier policy switch", () => {
  it("off holds a low-tier policy touch g10-adversary as before", async () => {
    expect(await hold(rig([file(HOLD_CLOSURE_PATH, 10)]), "off")).toBe("g10-adversary: policy touch");
  });

  it("shadow holds it g10-adversary and names the review it would have had", async () => {
    expect(await hold(rig([file(HOLD_CLOSURE_PATH, 10)]), "shadow")).toBe("g10-adversary: policy touch (shadow: low tier hold-closure)");
  });

  it("on holds it g10-review", async () => {
    expect(await hold(rig([file(HOLD_CLOSURE_PATH, 10)]), "on")).toBe(LOW_TIER_HOLD);
  });
});

describe("the low-tier policy hold at a later head", () => {
  it("a low-tier run whose next head adds an authority path is re-held g10-adversary", async () => {
    const r = rig([file(HOLD_CLOSURE_PATH, 10)]);
    await hold(r);
    r.store.releaseIfHeld("run-1", LOW_TIER_HOLD, { actor: "shepherd" });
    r.setFiles([file(HOLD_CLOSURE_PATH, 10), file(AUTHORITY_PATH, 5)]);

    expect(await reclassAtNextHead(r)).toEqual({ reclassed: false, held: "g10-adversary: authority, policy touch (kept: authority touch)" });
    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: "g10-adversary: authority, policy touch (kept: authority touch)" });
  });

  it("a released low-tier hold is not re-held at a later low-tier head", async () => {
    const r = rig([file(HOLD_CLOSURE_PATH, 10)]);
    await hold(r);
    r.store.releaseIfHeld("run-1", LOW_TIER_HOLD, { actor: "shepherd" });
    r.setFiles([file(HOLD_CLOSURE_PATH, 20)]);

    expect(await reclassAtNextHead(r)).toEqual({ reclassed: false });
    expect(r.store.byRun("run-1")?.held).toBe(false);
  });
});

describe("the sign-offs a low-tier policy touch needs", () => {
  it("a low-tier policy touch needs only the correctness sign-off", () => {
    const facts = { touches: ["policy"], paths: [HOLD_CLOSURE_PATH] };

    expect([requiredSignoffs(facts), requiredSignoffs({ ...facts, lowTier: true })]).toEqual([["correctness", "adversary"], ["correctness"]]);
  });
});
