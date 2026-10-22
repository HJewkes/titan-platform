import type { Logger } from "@titan-design/daemon";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { factoryMigrations } from "../host.js";
import { fakePoolClock } from "../test-support/pool-clock.js";
import { BOT_POOL_IDENTITY, buildBotPorts } from "./bot-ports.js";
import { reconcilerConfig } from "./config.js";
import { sqliteReconcilerCursor } from "./cursor.js";
import { BOT_LOGIN, REPO, fakeBotGithub, fakeObserve } from "./fakes.test-helpers.js";
import { createObserve } from "./observe.js";
import { createReconciler, type Observe } from "./service.js";

function botRig(observe: Observe = fakeObserve()) {
  const github = fakeBotGithub();
  const clock = fakePoolClock();
  const db = openDatabase(":memory:");
  runMigrations(db, factoryMigrations());
  const lines: string[] = [];
  const record = (_fields: Record<string, unknown>, msg: string) => void lines.push(msg);
  const log: Logger = { info: record, warn: record, error: record };
  const bot = buildBotPorts({ client: github.client, login: BOT_LOGIN, db, clock, lsRemote: (_repo, ref) => Promise.resolve("pr" in ref ? null : "c1"), observe });
  const { fullEvery } = reconcilerConfig({ reconciler: { repos: [REPO] } });
  const reconciler = createReconciler({ repos: [REPO], fullEvery }, { ...bot, db, cursor: sqliteReconcilerCursor(db, clock.now), log, now: clock.now });
  const pair = (callClass: string) =>
    db.prepare<[string, string], { state: string }>("SELECT state FROM factory_github_api_pool WHERE identity = ? AND call_class = ?").get(BOT_POOL_IDENTITY, callClass)?.state;
  const kinds = () => db.prepare<[], { kind: string }>("SELECT kind FROM factory_event ORDER BY seq").all().map((row) => row.kind);
  return { github, clock, lines, pair, kinds, tick: () => reconciler.tick() };
}

/** The start pass: it snapshots, and its gate read leaves the ETags the next tick sends. */
async function primed() {
  const r = botRig();
  await r.tick();
  return r;
}

/** As S3 holds `main` behind a commit whose checks still run, so the next read sees them finish. */
const holdingCursor: Observe = (...args) => ({ ...fakeObserve()(...args), cursor: {} });

const OBSERVED_NOW = () => Date.parse("2027-01-15T08:00:00Z");

const gateReads = (r: ReturnType<typeof botRig>, from: number) => r.github.requests.slice(from).filter((request) => request.route !== "graphql");

describe("production bot ports: conditional gates (TP-3431)", () => {
  it("sends no GraphQL on two quiet ticks of an unchanged repo and exactly one on the third", async () => {
    const r = await primed();
    expect(r.github.count("graphql")).toBe(1);
    const before = r.github.requests.length;

    await r.tick();
    await r.tick();
    expect(r.github.count("graphql")).toBe(1);
    await r.tick();

    expect(r.github.count("graphql")).toBe(2);
    const quiet = gateReads(r, before);
    expect(quiet).toHaveLength(9);
    expect(quiet.map((read) => read.ifNoneMatch)).toEqual([0, 1, 2].flatMap(() => ['"pulls-1"', '"ref-1"', '"rulesets-1"']));
  });

  it("sends the start pass's gate read unconditionally, since no earlier read vouches for anything", async () => {
    const r = botRig();

    await r.tick();

    expect(gateReads(r, 0).map((read) => [read.route, read.ifNoneMatch])).toEqual([
      ["pulls", undefined],
      ["ref", undefined],
      ["rulesets", undefined],
    ]);
  });

  it.each(["pulls", "ref", "rulesets"] as const)("snapshots on the quiet tick where the %s read changes", async (read) => {
    const r = await primed();
    r.github.versions[read] += 1;

    await r.tick();

    expect(r.github.count("graphql")).toBe(2);
  });

  it("snapshots an unchanged repo once over the start pass and the tick after it", async () => {
    const r = botRig();

    await r.tick();
    await r.tick();

    expect(r.github.count("graphql")).toBe(1);
  });

  it("logs RulesChanged from the gates' ruleset read at start, then only when the list moves", async () => {
    const r = botRig(createObserve({ now: OBSERVED_NOW }));
    await r.tick();
    await r.tick();
    expect(r.kinds().filter((kind) => kind === "RulesChanged")).toHaveLength(1);

    r.github.versions.rulesets += 1;
    await r.tick();

    expect(r.kinds().filter((kind) => kind === "RulesChanged")).toHaveLength(2);
  });

  it("does not snapshot for a free-plan repo's rulesets, which answer 403 on every read", async () => {
    const r = await primed();
    r.github.fail.set("rulesets", { status: 403, body: { message: "Upgrade to GitHub Pro or make this repository public to enable this feature." } });

    await r.tick();

    expect(r.github.count("graphql")).toBe(1);
  });

  it("keeps snapshotting a repo whose check is still running, though every gate answers 304", async () => {
    const r = botRig(holdingCursor);
    r.github.conclusion = null;
    await r.tick();
    await r.tick();

    await r.tick();
    await r.tick();

    expect(r.github.count("graphql")).toBe(4);
  });
});

describe("production bot ports: the durable pool (TP-3431)", () => {
  it("closes the bot's core-read pair in the factory table on a secondary limit, and the tick snapshots nothing", async () => {
    const r = await primed();
    r.github.fail.set("pulls", { status: 403, body: { message: "You have exceeded a secondary rate limit." }, headers: { "retry-after": "60" } });

    await r.tick();

    expect(r.pair("core-read")).toBe("closed");
    expect(r.github.count("graphql")).toBe(1);
    expect(r.lines).toContain("reconciler.skipped");
  });

  it("reopens a closed pair through the bot's own GET /rate_limit once the limit's reset passes", async () => {
    const r = await primed();
    r.github.fail.set("pulls", { status: 403, body: { message: "You have exceeded a secondary rate limit." }, headers: { "retry-after": "60" } });
    await r.tick();
    r.github.fail.delete("pulls");

    await r.clock.advance(60_000);

    expect(r.github.count("rate_limit")).toBe(1);
    expect(r.pair("core-read")).toBe("probed");
  });

  it("closes the graphql pair on GraphQL's primary limit, which GitHub answers as a 200 naming it", async () => {
    const r = botRig();
    r.github.fail.set("graphql", { status: 200, body: { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for installation ID 1." }] } });

    await r.tick();

    expect(r.pair("graphql")).toBe("closed");
    expect(r.lines).toContain("reconciler.skipped");
    expect(r.lines).not.toContain("reconciler.unit-failed");
  });
});
