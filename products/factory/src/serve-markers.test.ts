import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { silentLogger } from "@titan-design/daemon";
import type { Db } from "@titan-design/store-sqlite";
import { gitIn, seedRepoWithOrigin } from "@titan-design/test-kit/git";
import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseConfig } from "./config.js";
import { configRef } from "./config-ref.js";
import { defineWorkflow } from "./definition.js";
import { advanceEpoch } from "./head-guard/epoch-store.js";
import type { FactoryRoutes } from "./host.js";
import { markerHistory } from "./markers/marker-store.js";
import { readLog } from "./markers/shadow-diff/log.js";
import { isFactEntry } from "./registry/entry.js";
import { entryFor } from "./registry/registry.js";
import { factoryRegistry } from "./registry/steps/index.js";
import { markerShadowOptions } from "./serve-markers.js";
import { startFactoryServer, type FactoryServer } from "./serve.js";
import { fakeOwnerHelper } from "./test-support/owner-edges.js";

const ITEM = { repo: "Owner/Name", pr: 7 };
const ITEM_KEY = "owner/name#7";
const NOW = "2026-11-01T12:00:00.000Z";

const ciFixture = defineWorkflow({
  name: "ci-fixture",
  steps: [
    { id: "ci-wait", kind: "dispatch" },
    { id: "sh-await-verdict", kind: "dispatch" },
    { id: "fixture-approve", kind: "assisted" },
  ],
  run: async (ctx) => {
    await ctx.dispatch("ci-wait", "wait", { schema: z.looseObject({ verdict: z.string() }) });
    await ctx.dispatch("sh-await-verdict", "await", { schema: z.looseObject({ outcome: z.string() }) });
    await ctx.assisted("fixture-approve", "Land it?", { brief: { summary: "Land the fixture PR? Nothing else waits on it.", evidenceRef: "$ git log -1" } });
  },
});

let root: string;
const servers: FactoryServer[] = [];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "serve-markers-")));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The config file is both what serve's routes read and what the seat-checkout lookup reads, as in production. */
function routesFor(config: object, head: string): FactoryRoutes {
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify(config));
  vi.stubEnv("TITAN_FACTORY_CONFIG", file);
  const routes: StepRoute[] = [
    { match: "ci-wait", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: JSON.stringify({ verdict: "green", headSha: head, mergeableState: "clean" }) }) } },
    { match: "sh-await-verdict", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: JSON.stringify({ outcome: "MERGE", head }) }) } },
  ];
  return Object.assign(routes, { config: configRef(file) });
}

async function serveAndDrive(config: object, head: string): Promise<{ db: Db; run: WorkflowRun }> {
  const server = await startFactoryServer({
    dbPath: path.join(root, "factory.sqlite3"),
    workflows: [ciFixture],
    routes: routesFor(config, head),
    gatePollMs: 10,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    build: { sha: "0".repeat(40), behindMain: { status: () => 0, refresh: async () => undefined } },
  });
  servers.push(server);
  advanceEpoch(server.host.db, { ...ITEM, expectedEpoch: 0, head, by: "bootstrap", at: NOW });
  void fakeOwnerHelper(undefined);
  const id = server.host.runtime.start("ci-fixture", { repo: ITEM.repo, pr: String(ITEM.pr) });
  await vi.waitFor(() => expect(server.host.runtime.status(id)?.status).toMatch(/^(paused|completed|failed)$/), { timeout: 30_000 });
  return { db: server.host.db, run: server.host.runtime.status(id)! };
}

function factOf(step: string): string {
  const entry = entryFor(factoryRegistry, step);
  if (!entry || !isFactEntry(entry)) throw new Error(`${step} is a fact entry`);
  return entry.fact;
}

const ENABLED = { markers: { shadow: { enabled: true } } };
const noDb = (): Db => {
  throw new Error("no database in this test");
};

describe("serve wires the marker shadow from markers.shadow", () => {
  it("serve with no markers config sets no marker shadow and writes no log row", async () => {
    const { db, run } = await serveAndDrive({}, "d".repeat(40));

    expect(run.status).toBe("paused");
    expect(readLog(db, { sinceIso: "" })).toEqual([]);
    expect(markerHistory(db, { item: ITEM_KEY, fact: factOf("ci-wait") })).toEqual([]);
    for (const text of ["{}", '{ "markers": { "shadow": {} } }']) expect(markerShadowOptions(parseConfig("config.json", text).markers, noDb, root, () => undefined)).toBeUndefined();
  });

  it("serve with markers.shadow.enabled writes a verdict row and a marker beside step_results for a ci-wait run", async () => {
    const { db, run } = await serveAndDrive(ENABLED, "d".repeat(40));

    expect(run.status).toBe("paused");
    const logged = readLog(db, { sinceIso: "" });
    expect(logged).toContainEqual(expect.objectContaining({ kind: "verdict", runId: run.id, step: "ci-wait" }));
    // No seat clone binds the repo, so the diff pin throws inside the shadow; the run never sees it.
    expect(logged).toContainEqual(expect.objectContaining({ kind: "shadow-error", runId: run.id, step: "sh-await-verdict" }));
    expect(markerHistory(db, { item: ITEM_KEY, fact: factOf("ci-wait") })).toEqual([expect.objectContaining({ runId: run.id, pinClass: "tree", pin: `${"d".repeat(40)}@e1` })]);
  });

  it("a verdict:merge call under the enabled shadow pins through the mirror instead of reading 'no diff pin source'", async () => {
    const seat = seatCloneWithTopic();
    const config = { ...ENABLED, shepherd: { repos: { [ITEM.repo]: { path: seat.dir } } } };

    const { db, run } = await serveAndDrive(config, seat.head);

    expect(run.status).toBe("paused");
    const [marker] = markerHistory(db, { item: ITEM_KEY, fact: "verdict:merge" });
    expect(marker).toMatchObject({ runId: run.id, pinClass: "diff" });
    expect(fs.existsSync(path.join(root, "marker-git", "owner__name.git", "HEAD"))).toBe(true);
    const probe = await markerShadowOptions(parseConfig("config.json", JSON.stringify(config)).markers, noDb, root, () => seat.dir)!.carryProbe!(ITEM, seat.head, seat.head);
    expect(probe).toMatchObject({ reviewed: { kind: "exact", full: marker!.pin }, current: { kind: "exact", full: marker!.pin }, headIsMerge: false });
  });

  it("an unknown key under markers fails the config load", () => {
    expect(() => parseConfig("config.json", '{ "markers": { "shadow": { "enabled": true }, "gc": {} } }')).toThrow(/markers: Unrecognized key: "gc"/);
    expect(() => parseConfig("config.json", '{ "markers": { "shadow": { "enable": true } } }')).toThrow(/markers\.shadow: Unrecognized key: "enable"/);
  });
});

/** A seat clone of a synthetic origin whose `topic` branch is one commit past main. */
function seatCloneWithTopic(): { dir: string; head: string } {
  const author = path.join(root, "author");
  seedRepoWithOrigin(author, path.join(root, "origin.git"), { "a.txt": "line 1\nline 2\n" });
  const git = gitIn(author);
  git("checkout", "-q", "-b", "topic");
  fs.writeFileSync(path.join(author, "a.txt"), "line 1\ntopic\n");
  git("commit", "-q", "-a", "-m", "topic");
  git("push", "-q", "origin", "HEAD:refs/heads/topic");
  const dir = path.join(root, "seat");
  gitIn(root)("clone", "-q", path.join(root, "origin.git"), dir);
  return { dir, head: git("rev-parse", "HEAD") };
}
