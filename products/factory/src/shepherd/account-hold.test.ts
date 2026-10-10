import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { ACCOUNT_WAIT_LIMIT_MS, accountRoutes, accountWithHeadroom, type AccountsView } from "./account-hold.js";
import { RECHECK_AFTER_MS } from "./account-limit.js";
import { AccountLimitStore, accountLimitMigration, type AccountLimitStoreRef } from "./account-store.js";
import type { ShepherdDeps } from "./phases.js";
import { shepherdEventMigration } from "./events.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, shepherdMigration, sliceMigration, type ShepherdStoreRef } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("account-hold-head");
const T0 = Date.parse("2026-10-08T05:49:00.000Z");
const NOTICE = "You've hit your weekly limit · resets Oct 10 at 6pm (America/Denver)";
const ACCOUNT = "/accounts/review";
const HELD = `account-exhausted: ${ACCOUNT} until 2026-10-11T00:00:00.000Z; TP-1955`;

function migrated(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), accountLimitMigration(17)]);
  return db;
}

/** A scene over one database; `restart` swaps in a new store over it, as a factory restart does. */
function scene(options: { alert?: (text: string) => Promise<void>; dirs?: string[] } = {}) {
  const db = migrated();
  const clock = { now: T0 };
  let store = new ShepherdStore(db, () => clock.now);
  const ref = { get: () => store } as unknown as ShepherdStoreRef;
  const fake = fakeGitHub({ repo: REPO });
  fake.addPr({ headSha: HEAD });
  const limits = { get: () => new AccountLimitStore(db, () => clock.now) } as unknown as AccountLimitStoreRef;
  const deps = { port: githubPort(fake.wire), store: ref, accountLimits: limits, now: () => clock.now, sleep: async (ms: number) => void (clock.now += ms), pollMs: 60_000 } as unknown as ShepherdDeps;
  const alerts: string[] = [];
  const accounts: AccountsView = { dirs: options.dirs ?? [ACCOUNT], alert: options.alert ?? (async (_repo, text) => void alerts.push(text)) };
  const routes = accountRoutes(deps, accounts);
  const run = async (match: string, input: object) => {
    const outcome = await routes.find((route) => route.match === match)!.runner.run({ prompt: JSON.stringify(input), signal: new AbortController().signal, attempt: 0, requestKey: "k", stepId: match } as never);
    return outcome.ok ? JSON.parse(outcome.output).result : outcome;
  };
  const register = (runId: string, pr: number) => store.register({ repo: REPO, pr, runId, task: "demo", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  const hold = (runId: string, pr = 1, notice: string | undefined = NOTICE, resetsAt?: number) => run("sh-account-hold", { repo: REPO, pr, head: HEAD, runId, account: ACCOUNT, ...(notice && { notice }), ...(resetsAt !== undefined && { resetsAt }) });
  const wait = (runId: string, own = true) => run("sh-account-wait", { repo: REPO, pr: 1, head: HEAD, runId, account: ACCOUNT, own });
  /** What `sh-review-intent` does when it picks an account: the one place the run's own hold is lifted. */
  const pick = (runId: string) => accountWithHeadroom(deps, accounts.dirs, runId);
  return { db, clock, store: () => store, limits: () => limits.get(), pick, restart: () => void (store = new ShepherdStore(db, () => clock.now)), alerts, hold, wait, register, fake };
}

describe("sh-account-hold", () => {
  it("holds the run through the store hold, with the account-exhausted reason naming the account and its reset", async () => {
    const s = scene();
    s.register("run-1", 1);

    const held = await s.hold("run-1");

    expect(held).toEqual({ held: true, own: true, reason: HELD });
    expect(s.store().byRun("run-1")).toMatchObject({ held: true, holdReason: HELD });
  });

  it("alerts once per exhaustion of an account, across two runs and across a restart", async () => {
    const s = scene();
    s.register("run-1", 1);
    s.register("run-2", 2);

    await s.hold("run-1", 1);
    await s.hold("run-2", 2);
    s.restart();
    await s.hold("run-1", 1, undefined);

    expect(s.alerts).toEqual([`Shepherd: the review account ${ACCOUNT} hit its usage limit and resets at 2026-10-11T00:00:00.000Z. Reviews that would bill it are held (account-exhausted). Held runs resume on their own after the reset.`]);
  });

  it("alerts again for a new exhaustion after the last one's reset passed", async () => {
    const s = scene();
    s.register("run-1", 1);
    await s.hold("run-1");

    s.clock.now = Date.parse("2026-10-14T12:00:00.000Z");
    await s.hold("run-1", 1, "You've hit your weekly limit · resets Oct 17 at 6pm (America/Denver)");

    expect(s.alerts).toHaveLength(2);
  });

  it("takes the reset the client recorded on the notice over the one in its text", async () => {
    const s = scene();
    s.register("run-1", 1);

    const held = await s.hold("run-1", 1, NOTICE, Date.parse("2026-10-09T18:00:00.000Z"));

    expect(held).toMatchObject({ reason: `account-exhausted: ${ACCOUNT} until 2026-10-09T18:00:00.000Z; TP-1955` });
  });

  it("caps a reset six months out at an hour, then a re-check, instead of an indefinite mark", async () => {
    const s = scene();
    s.register("run-1", 1);

    const held = await s.hold("run-1", 1, NOTICE, T0 + 180 * 24 * 60 * 60_000);

    expect(held).toMatchObject({ reason: `account-exhausted: ${ACCOUNT} until ${new Date(T0 + RECHECK_AFTER_MS).toISOString()}; TP-1955` });
    expect(s.limits().exhausted(ACCOUNT)?.resetsAt).toBe(T0 + RECHECK_AFTER_MS);
  });

  it("does not alert again when the account is hit again within the hour after an hour-long mark lapsed", async () => {
    const s = scene();
    s.register("run-1", 1);
    await s.hold("run-1", 1, "You've hit your weekly limit");

    s.clock.now = T0 + RECHECK_AFTER_MS + 5 * 60_000;
    await s.hold("run-1", 1, "You've hit your weekly limit");

    expect(s.alerts).toHaveLength(1);
  });

  it("tries the alert again on the next hold when the seat could not be told", async () => {
    const sent: string[] = [];
    let fail = true;
    const s = scene({ alert: async (text) => (fail ? Promise.reject(new Error("seat is offline")) : void sent.push(text)) });
    s.register("run-1", 1);

    await s.hold("run-1");
    fail = false;
    await s.hold("run-1", 1, undefined);

    expect(sent).toHaveLength(1);
  });

  it("leaves an owner's own hold in place, and says the hold is not its own", async () => {
    const s = scene();
    s.register("run-1", 1);
    s.store().hold("run-1", "owner: waiting on the design call");

    const held = await s.hold("run-1");

    expect(held).toMatchObject({ held: true, own: false });
    expect(s.store().byRun("run-1")?.holdReason).toBe("owner: waiting on the design call");
  });

  it("holds with an unknown reset when the store cannot be read, failing closed", async () => {
    const s = scene();
    s.register("run-1", 1);
    s.db.exec("DROP TABLE shepherd_account_limit");

    const held = await s.hold("run-1");

    expect(held).toEqual({ held: true, own: true, reason: `account-exhausted: ${ACCOUNT} until an unknown reset; TP-1955` });
  });

  it("does not hold, and names the next account, when a fallback account has headroom", async () => {
    const s = scene({ dirs: [ACCOUNT, "/accounts/spare"] });
    s.register("run-1", 1);

    const held = await s.hold("run-1");

    expect(held).toMatchObject({ held: false, reason: expect.stringContaining("moves to /accounts/spare") });
    expect(s.store().byRun("run-1")?.held).toBe(false);
    expect(s.alerts).toHaveLength(1);
  });

  it("lifts its own earlier hold when it fails over to a fallback that has headroom again", async () => {
    const s = scene({ dirs: [ACCOUNT, "/accounts/spare"] });
    s.register("run-1", 1);
    s.limits().markExhausted("/accounts/spare", T0 + RECHECK_AFTER_MS, "You've hit your weekly limit");
    expect(await s.hold("run-1")).toMatchObject({ held: true, own: true });

    s.clock.now = T0 + RECHECK_AFTER_MS + 60_000;
    const moved = await s.hold("run-1");

    expect(moved).toMatchObject({ held: false, reason: expect.stringContaining("moves to /accounts/spare") });
    expect(s.store().byRun("run-1")?.held).toBe(false);
  });
});

describe("sh-account-wait", () => {
  it("lifts only its own hold at the reset: an owner hold that merely looks like one survives", async () => {
    for (const reason of ["Account-exhausted: manual", "account-exhausted: manual"]) {
      const s = scene();
      s.register("run-1", 1);
      s.store().hold("run-1", reason);
      const held = await s.hold("run-1");
      s.clock.now = Date.parse("2026-10-10T23:59:00.000Z");

      expect(held).toMatchObject({ held: true, own: false });
      expect(await s.wait("run-1", held.own)).toEqual({ resumed: "headroom" });
      expect(s.pick("run-1")).toBe(ACCOUNT);
      expect(s.store().byRun("run-1")).toMatchObject({ held: true, holdReason: reason });
    }
  });

  it("ends without lifting anything when an owner re-holds the run over its own hold", async () => {
    const s = scene();
    s.register("run-1", 1);
    await s.hold("run-1");
    s.store().hold("run-1", "Account-exhausted: manual");

    expect(await s.wait("run-1")).toEqual({ resumed: "released" });
    expect(s.store().byRun("run-1")).toMatchObject({ held: true, holdReason: "Account-exhausted: manual" });
    expect(s.limits().exhausted(ACCOUNT)).toBeDefined();
  });

  it("waits until the reset and ends there, leaving the hold for the next account pick to lift", async () => {
    const s = scene();
    s.register("run-1", 1);
    await s.hold("run-1");
    s.clock.now = Date.parse("2026-10-10T23:30:00.000Z");

    const waited = await s.wait("run-1");

    expect(waited).toEqual({ resumed: "headroom" });
    expect(s.clock.now).toBeGreaterThanOrEqual(Date.parse("2026-10-11T00:00:00.000Z"));
    expect(s.store().byRun("run-1")?.held).toBe(true);
    expect(s.pick("run-1")).toBe(ACCOUNT);
    expect(s.store().byRun("run-1")?.held).toBe(false);
  });

  it("lifts nothing at the account pick while the account is still exhausted", async () => {
    const s = scene();
    s.register("run-1", 1);
    await s.hold("run-1");

    expect(s.pick("run-1")).toBeNull();
    expect(s.store().byRun("run-1")?.held).toBe(true);
  });

  it("ends at its limit with the hold still in place, so the run reads its head and holds again", async () => {
    const s = scene();
    s.register("run-1", 1);
    await s.hold("run-1");

    const waited = await s.wait("run-1");

    expect(waited).toEqual({ resumed: "expired" });
    expect(s.clock.now - T0).toBe(ACCOUNT_WAIT_LIMIT_MS);
    expect(s.store().byRun("run-1")?.holdReason).toBe(HELD);
  });

  it("takes an owner's release as headroom for the account, so the next review may bill it", async () => {
    const s = scene();
    s.register("run-1", 1);
    await s.hold("run-1");
    s.store().release("run-1");

    const waited = await s.wait("run-1");

    expect(waited).toEqual({ resumed: "released" });
    expect(s.limits().exhausted(ACCOUNT)).toBeUndefined();
  });

  it("ends when the PR's head moves, keeping the hold", async () => {
    const s = scene();
    s.register("run-1", 1);
    await s.hold("run-1");
    s.fake.pushHead(1, fakeSha("account-hold-next"));

    expect(await s.wait("run-1")).toEqual({ resumed: "head-moved" });
    expect(s.store().byRun("run-1")?.held).toBe(true);
  });

  it("keeps waiting while the store cannot be read, failing closed", async () => {
    const s = scene();
    s.register("run-1", 1);
    await s.hold("run-1");
    s.db.exec("DROP TABLE shepherd_account_limit");

    expect(await s.wait("run-1")).toEqual({ resumed: "expired" });
  });
});
