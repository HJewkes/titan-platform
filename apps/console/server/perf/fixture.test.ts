import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "@titan-design/daemon";
import { inProcessCaller } from "@titan-design/registry";
import { createConsoleRegistry } from "../registry.js";
import type { ConsoleContext } from "../owner-guard.js";
import { createSources } from "../upstreams.js";
import { AW_SIZES } from "./active-work-state.js";
import { BROKER_SIZES } from "./broker-state.js";
import { DISK_SIZES } from "./disk-state.js";
import { FACTORY_SIZES } from "./factory-state.js";
import { buildPerfFixture, perfState, type PerfFixture } from "./fixture.js";

const dirs: string[] = [];
const fixtures: PerfFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function build(seed?: string): Promise<PerfFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), "console-perf-fixture-"));
  dirs.push(dir);
  const fixture = await buildPerfFixture(dir, seed);
  fixtures.push(fixture);
  return fixture;
}

/** Every file under `dir` by relative path, with its bytes and mtime, so two trees hash equal only when a reader sees them the same. */
async function treeDigest(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const names = (await readdir(dir, { recursive: true })).sort();
  for (const name of names) {
    const file = path.join(dir, name);
    const info = await stat(file);
    if (!info.isFile()) continue;
    hash.update(`${name}\0${info.mtimeMs}\0`).update(await readFile(file));
  }
  return hash.digest("hex");
}

const call = (fixture: PerfFixture) => {
  const registry = createConsoleRegistry(createSources(fixture.config, silentLogger));
  const context = (): ConsoleContext => ({ warnings: [], format: "json", surface: "in-process", auth: null, ownerWrites: false });
  return inProcessCaller(registry, context);
};

describe("the perf fixture", () => {
  it("writes the same bytes and serves the same answers from one seed, and different ones from another", async () => {
    const [first, second] = [await build(), await build()];

    expect(await treeDigest(path.dirname(second.config.stateDir))).toBe(await treeDigest(path.dirname(first.config.stateDir)));
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
    expect(JSON.stringify(perfState("another-seed"))).not.toBe(JSON.stringify(first.state));
  });

  it("holds the audit's large state", async () => {
    const fixture = await build();
    const rounds = await readdir(fixture.config.roundsDir);
    const spool = await readdir(fixture.config.inboxDir);
    const withdrawals = (await readFile(path.join(fixture.config.inboxDir, "withdrawals.jsonl"), "utf8")).trim().split("\n");

    expect(rounds).toHaveLength(DISK_SIZES.rounds);
    expect(spool.filter((name) => name.endsWith(".json") && !name.endsWith(".answer.json"))).toHaveLength(DISK_SIZES.deposits);
    expect(withdrawals).toHaveLength(DISK_SIZES.withdrawnDeposits);
    expect(fixture.state.activeWork.tasks).toHaveLength(AW_SIZES.initiatives * AW_SIZES.tasksPerInitiative);
    expect(fixture.state.factory.finished).toHaveLength(FACTORY_SIZES.finishedRuns);
    expect(fixture.state.broker.messages).toHaveLength(BROKER_SIZES.messages);
  });

  it("answers the console's reads in process and counts each upstream call by command", async () => {
    const fixture = await build();
    const rpc = call(fixture);

    const rounds = await rpc("rounds.list", {});
    expect(rounds).toMatchObject({ ok: true, data: { rounds: expect.any(Array) } });
    expect(JSON.stringify(rounds)).not.toContain('"valid":false');
    expect(fixture.calls.total()).toBe(0);

    expect(await rpc("shepherd.list", { state: "finished" })).toMatchObject({ ok: true, data: expect.arrayContaining([expect.objectContaining({ runId: "run-00300" })]) });
    expect(await rpc("autoresearch.runs", {})).toMatchObject({ ok: true, data: expect.any(Array) });
    expect(fixture.calls.counts()).toEqual({ "factory autoresearch.runs": 1, "factory shepherd.list": 1 });

    fixture.calls.reset();
    expect(await rpc("work.portfolio", {})).toMatchObject({ ok: true });
    expect(fixture.calls.counts()).toMatchObject({ "active-work list": expect.any(Number), "active-work inventory": expect.any(Number) });
  });

  it("forgets the broker's calls on reset, as it forgets the daemons'", async () => {
    const fixture = await build();
    const rpc = call(fixture);
    await rpc("agents.roster", {});

    fixture.calls.reset();
    expect(await rpc("agents.roster", {})).toMatchObject({ ok: true });

    expect(fixture.calls.counts()).toEqual({ "broker /api/history": 1, "broker /api/sessions": 1 });
  });
});
