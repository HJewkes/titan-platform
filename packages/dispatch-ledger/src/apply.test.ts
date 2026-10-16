import { describe, expect, expectTypeOf, it } from "vitest";
import { applyActions, type ClaimPatch, type LedgerAction } from "./apply.js";
import { EMPTY_LEDGER, type Claim, type LadderRecord, type Ledger } from "./schema.js";

const T0 = "2026-01-05T08:00:00.000Z";
const NOW = new Date("2026-01-05T09:00:00.000Z");
const LATER = new Date("2026-01-05T10:00:00.000Z");
const KEY = { taskId: "TX-1", slice: "a" };

const claim = (over: Partial<Claim> = {}): Claim => ({
  taskId: "TX-1",
  initiative: "demo",
  spawnedAt: T0,
  phase: "implementing",
  phaseAt: T0,
  slice: "a",
  agentName: "bd-tx-1-a",
  ...over,
});

const ledgerOf = (...claims: Claim[]): Ledger => ({ version: 1, claims });

const update = (patch: ClaimPatch): LedgerAction => ({ kind: "update", key: KEY, patch });

const only = (ledger: Ledger): Claim => {
  const [c] = ledger.claims;
  if (c === undefined) throw new Error("no claim");
  return c;
};

describe("applyActions on an update", () => {
  it("restarts the phase clock on a phase change and keeps it otherwise", () => {
    const moved = only(applyActions(ledgerOf(claim()), [update({ phase: "shepherding" })], NOW));
    const kept = only(applyActions(ledgerOf(claim()), [update({ phase: "implementing", pr: "o/r#9" })], NOW));

    expect(moved).toMatchObject({ phase: "shepherding", phaseAt: NOW.toISOString() });
    expect(kept).toMatchObject({ phase: "implementing", phaseAt: T0, pr: "o/r#9" });
  });

  it("restarts the phase clock for a new agent in the same phase", () => {
    const spawning = claim({ phase: "spawning" });

    const after = only(applyActions(ledgerOf(spawning), [update({ agentName: "bd-tx-1-a-s1" })], NOW));

    expect(after).toMatchObject({ phase: "spawning", phaseAt: NOW.toISOString(), agentName: "bd-tx-1-a-s1" });
  });

  it("stamps stalledAt once for a new stall and keeps it while the stall holds", () => {
    const first = applyActions(ledgerOf(claim()), [update({ stalledReason: "no-progress: quiet" })], NOW);
    const second = applyActions(first, [update({ stalledReason: "no-progress: still quiet" })], LATER);

    expect(only(first).stalledAt).toBe(NOW.toISOString());
    expect(only(second)).toMatchObject({ stalledReason: "no-progress: still quiet", stalledAt: NOW.toISOString() });
  });

  it("drops stalledAt and stale when the stall clears", () => {
    const stale = { class: "timeout" as const, proposed: "release", since: T0 };
    const stalled = claim({ stalledReason: "phase-timeout: 4h", stalledAt: T0, stale });

    const held = only(applyActions(ledgerOf(stalled), [update({ stalledReason: "phase-timeout: 5h" })], NOW));
    const cleared = only(applyActions(ledgerOf(stalled), [update({ stalledReason: undefined })], NOW));

    expect(held).toMatchObject({ stalledAt: T0, stale });
    expect(cleared.stalledAt).toBeUndefined();
    expect(cleared.stale).toBeUndefined();
  });

  it("drops stale on a restart while the stall holds", () => {
    const stale = { class: "timeout" as const, proposed: "release", since: T0 };
    const stalled = claim({ stalledReason: "phase-timeout: 4h", stalledAt: T0, stale });

    const after = only(applyActions(ledgerOf(stalled), [update({ phase: "spawning" })], NOW));

    expect(after).toMatchObject({ stalledAt: T0, phaseAt: NOW.toISOString() });
    expect(after.stale).toBeUndefined();
  });

  it("leaves a done claim of the same key alone", () => {
    const done = claim({ phase: "done" });

    expect(applyActions(ledgerOf(done), [update({ phase: "queued" })], NOW).claims).toEqual([done]);
  });
});

describe("applyActions on a release", () => {
  const planned = claim({
    dependsOn: ["z"],
    owns: ["src/a.ts"],
    repo: "example-org/example-repo",
    contracts: [{ scope: "api", op: "add" }],
    overlapsAccepted: [{ pr: 12, path: "src/a.ts", why: "line-local" }],
    seat: "seat-a",
    namePrefix: "sa",
    agentId: "a1",
    pr: "o/r#9",
    attempt: 2,
    stalledReason: "no-progress: quiet",
  });
  const release = (requeue: boolean): LedgerAction => ({
    kind: "release",
    key: KEY,
    requeue,
    code: "no-progress",
    branch: "agent-chat/bd-tx-1-a",
    names: ["bd-tx-1-a"],
  });

  it("requeues a slice with only the planner fields and counts the release twice", () => {
    const ledger: Ledger = {
      ...ledgerOf(planned),
      releases: { "TX-1": { n: 1, at: T0 } },
      ladder: { "TX-1#a": { respawns: 2, lastAt: T0, releases: 1 } },
    };

    const after = applyActions(ledger, [release(true)], NOW);

    expect(after.claims).toEqual([
      {
        taskId: "TX-1",
        initiative: "demo",
        spawnedAt: T0,
        phase: "queued",
        phaseAt: NOW.toISOString(),
        slice: "a",
        dependsOn: ["z"],
        owns: ["src/a.ts"],
        repo: "example-org/example-repo",
        contracts: [{ scope: "api", op: "add" }],
        overlapsAccepted: [{ pr: 12, path: "src/a.ts", why: "line-local" }],
        seat: "seat-a",
        namePrefix: "sa",
      },
    ]);
    expect(after.releases).toEqual({ "TX-1": { n: 2, at: NOW.toISOString() } });
    expect(after.ladder?.["TX-1#a"]).toEqual({
      respawns: 2,
      releases: 2,
      lastAt: NOW.toISOString(),
      code: "no-progress",
      branch: "agent-chat/bd-tx-1-a",
      seat: "seat-a",
    });
  });

  it("drops the claim when it does not requeue, starting both counts at one", () => {
    const after = applyActions(ledgerOf(planned), [release(false)], NOW);

    expect(after.claims).toEqual([]);
    expect(after.releases?.["TX-1"]?.n).toBe(1);
    expect(after.ladder?.["TX-1#a"]).toMatchObject({ respawns: 0, releases: 1 });
  });
});

describe("applyActions on a release's recorded cause", () => {
  const KEY_B = { taskId: "TX-1", slice: "b" };
  const REASON = "stack-broken: parent TX-1 a #10 closed";
  const child = claim({
    slice: "b",
    dependsOn: ["a"],
    seat: "seat-a",
    stackedOn: { taskId: "TX-1", slice: "a", pr: "o/r#10", branch: "agent-chat/bd-tx-1-a", forkHead: "abc000" },
  });
  const releaseB = (cause: { code?: "lease-expired" | "no-progress"; reason?: string }): LedgerAction => ({
    kind: "release",
    key: KEY_B,
    requeue: true,
    ...cause,
    branch: "agent-chat/bd-tx-1-b",
    names: ["bd-tx-1-b"],
  });
  const withRecord = (record: LadderRecord): Ledger => ({ ...ledgerOf(child), ladder: { "TX-1#b": record } });

  it("stores a release's reason and drops a carried-over code", () => {
    const before = withRecord({ respawns: 1, lastAt: T0, releases: 0, code: "no-progress" });

    const after = applyActions(before, [releaseB({ reason: REASON })], NOW);

    expect(after.ladder?.["TX-1#b"]).toMatchObject({ reason: REASON, releases: 1 });
    expect(after.ladder?.["TX-1#b"]?.code).toBeUndefined();
  });

  it("stores a release's code and drops a carried-over reason", () => {
    const before = withRecord({ respawns: 1, lastAt: T0, releases: 1, reason: REASON });

    const after = applyActions(before, [releaseB({ code: "lease-expired" })], NOW);

    expect(after.ladder?.["TX-1#b"]).toMatchObject({ code: "lease-expired", releases: 2 });
    expect(after.ladder?.["TX-1#b"]?.reason).toBeUndefined();
  });

  it("writes the released record in agent-chat's key order, the new code after the kept keys", () => {
    const before = withRecord({ respawns: 1, code: "no-progress", lastAt: T0, occurrence: T0, releases: 0 });

    const after = applyActions(before, [releaseB({ code: "lease-expired" })], NOW);

    expect(Object.keys(after.ladder?.["TX-1#b"] ?? {})).toEqual([
      "respawns",
      "lastAt",
      "occurrence",
      "releases",
      "code",
      "branch",
      "seat",
    ]);
  });

  it("requeues a stacked child without its stackedOn", () => {
    const after = applyActions(ledgerOf(child), [releaseB({ reason: REASON })], NOW);

    expect(only(after)).toMatchObject({ phase: "queued", dependsOn: ["a"] });
    expect(only(after).stackedOn).toBeUndefined();
    expect(after.ladder?.["TX-1#b"]?.branch).toBe("agent-chat/bd-tx-1-b");
  });
});

describe("applyActions on the ladder, brake and pass-through kinds", () => {
  const record: LadderRecord = { respawns: 1, lastAt: T0 };

  it("writes a ladder record and prunes the ladder once its last record goes", () => {
    const written = applyActions(ledgerOf(claim()), [{ kind: "ladder", key: KEY, record }], NOW);
    const pruned = applyActions(written, [{ kind: "ladder", key: KEY }], NOW);

    expect(written.ladder).toEqual({ "TX-1#a": record });
    expect("ladder" in pruned).toBe(false);
  });

  it("keeps the other records when one is pruned", () => {
    const ledger: Ledger = { ...ledgerOf(), ladder: { "TX-1#a": record, "TX-2#": record } };

    expect(applyActions(ledger, [{ kind: "ladder", key: KEY }], NOW).ladder).toEqual({ "TX-2#": record });
  });

  it("sets the brake, and clears it for an undefined brake", () => {
    const brake = { at: [T0] };
    const braked = applyActions(EMPTY_LEDGER, [{ kind: "brake", brake }], NOW);
    const cleared = applyActions(braked, [{ kind: "brake" }], NOW);

    expect(braked.brake).toEqual(brake);
    expect("brake" in cleared).toBe(false);
  });

  it("moves a re-set brake to the last key, as the exported file has it", () => {
    const ledger: Ledger = { version: 1, brake: { at: [T0] }, claims: [], lastTickAt: T0 };

    const after = applyActions(ledger, [{ kind: "brake", brake: { at: [T0, T0] } }], NOW);

    expect(Object.keys(after)).toEqual(["version", "claims", "lastTickAt", "brake"]);
  });

  it("adds claims through addClaim, refusing a held one", () => {
    const added = applyActions(EMPTY_LEDGER, [{ kind: "add", claims: [claim()] }], NOW);

    expect(added.claims).toEqual([claim()]);
    expect(() => applyActions(added, [{ kind: "add", claims: [claim()] }], NOW)).toThrow("already claimed");
  });

  it("leaves the ledger unchanged for spawn, retire and register", () => {
    const ledger = ledgerOf(claim());

    const after = applyActions(ledger, [{ kind: "spawn" }, { kind: "retire" }, { kind: "register" }], NOW);

    expect(after).toBe(ledger);
  });
});

describe("LedgerAction", () => {
  it("accepts a product action whose side-effect kinds carry product types", () => {
    type ProductAction =
      | { kind: "spawn"; key: { taskId: string }; role: "reviewer"; name: string; context?: { kind: "review" } }
      | { kind: "retire"; key: { taskId: string }; names: string[]; then?: ProductAction[] }
      | { kind: "register"; key: { taskId: string }; registration: { repo: string; pr: number } }
      | Extract<LedgerAction, { kind: "update" | "add" | "ladder" | "brake" | "release" }>;

    expectTypeOf<ProductAction>().toExtend<LedgerAction>();
  });

  it("accepts a product release with no stall code and a reason", () => {
    type ProductRelease = {
      kind: "release";
      key: { taskId: string; slice?: string };
      branch?: string;
      requeue: boolean;
      code?: "no-progress";
      reason?: string;
      names: string[];
    };

    expectTypeOf<ProductRelease>().toExtend<LedgerAction>();
  });
});
