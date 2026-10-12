import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub, silentLogger } from "@titan-design/daemon";
import { SqliteGateStore } from "@titan-design/hitl/sqlite";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFactoryServer, type FactoryServer, type FactoryServerOptions } from "../serve.js";
import { gateId, gateOpened, landScenario } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { shepherdFixture } from "../test-support/shepherd.js";
import { SHEPHERD_FRAME_EVENT, shepherdFrames, type ShepherdFrame } from "./frames.js";
import { OWNER_GATE_POLICY } from "./policy.js";

const POLL_MS = 20;
const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-frames-"));
  dirs.push(dir);
  return join(dir, "state", "factory.sqlite3");
}

async function serve(options: Pick<FactoryServerOptions, "dbPath" | "workflows" | "routes">): Promise<FactoryServer> {
  const server = await startFactoryServer({ ...options, gatePollMs: 10, framePollMs: POLL_MS, port: 0, logger: silentLogger, github: { status: () => "ok", refresh: async () => undefined } });
  cleanups.push(() => server.close());
  return server;
}

function framesOf(hub: EventHub): ShepherdFrame[] {
  const frames: ShepherdFrame[] = [];
  hub.subscribe((message) => void (message.event === SHEPHERD_FRAME_EVENT && frames.push(JSON.parse(message.data) as ShepherdFrame)));
  return frames;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("shepherd frames on serve's /events hub", () => {
  it("a run on serve broadcasts a gate frame naming the step it waits on, then run frames once answered in-process, never external", async () => {
    const scenario = landScenario();
    const server = await serve({ dbPath: dbFile(), workflows: [scenario.workflow], routes: scenario.routes });
    const frames = framesOf(server.hub);

    const runId = server.host.runtime.start("land-test");
    await gateOpened(server.host, gateId(runId, "approve-merge"));
    await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ v: 1, kind: "gate", runId, stepId: "approve-merge" })));
    server.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: scenario.fake.pr(1).headSha }, OWNER);

    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ v: 1, kind: "run", runId, at: expect.any(String) }));
    await wait(POLL_MS * 5);
    expect(frames.filter((frame) => frame.kind === "external")).toEqual([]);
  });

  it("a gate resolved through a second connection to the database yields an external frame", async () => {
    const dbPath = dbFile();
    const scenario = landScenario();
    const server = await serve({ dbPath, workflows: [scenario.workflow], routes: scenario.routes });
    const runId = server.host.runtime.start("land-test");
    const id = gateId(runId, "approve-merge");
    await gateOpened(server.host, id);
    const frames = framesOf(server.hub);
    const other = openDatabase(dbPath);
    cleanups.push(() => void other.close());

    new SqliteGateStore(other, { migrate: false }).resolve(id, { decision: "merge", headSha: scenario.fake.pr(1).headSha }, OWNER);

    await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ v: 1, kind: "external" })));
  });

  it("a registration this process writes yields a registration frame and never an external one", async () => {
    const fixture = shepherdFixture({ frozen: true });
    const server = await serve({ dbPath: dbFile(), workflows: fixture.workflows, routes: fixture.routes });
    const frames = framesOf(server.hub);

    fixture.routes.shepherd!.store.get().register({ repo: "octo/demo", pr: 7, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });

    await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ v: 1, kind: "registration", repo: "octo/demo", pr: 7, runId: "run-1" })));
    await wait(POLL_MS * 5);
    expect(frames.filter((frame) => frame.kind === "external")).toEqual([]);
  });

  it("closing serve stops the poll before the database closes under it", async () => {
    const scenario = landScenario();
    const server = await serve({ dbPath: dbFile(), workflows: [scenario.workflow], routes: scenario.routes });
    const errors: unknown[] = [];
    const onError = (err: unknown): number => errors.push(err);
    process.on("uncaughtException", onError);
    cleanups.push(() => void process.off("uncaughtException", onError));

    await server.close();
    await wait(POLL_MS * 5);

    expect(errors).toEqual([]);
  });
});

describe("shepherdFrames", () => {
  function started(): { frames: ShepherdFrame[]; source: ReturnType<typeof shepherdFrames> } {
    vi.useFakeTimers();
    const hub = new EventHub();
    const db = openDatabase(":memory:");
    cleanups.push(() => void db.close());
    const source = shepherdFrames({ pollMs: POLL_MS, now: () => 0 });
    source.start(hub, db);
    cleanups.push(() => source.close());
    return { frames: framesOf(hub), source };
  }

  it("three events for one run inside the window yield one frame carrying the latest", () => {
    const { frames, source } = started();

    source.onEvent({ type: "step_started", runId: "r1", stepId: "review", iteration: 0 });
    vi.advanceTimersByTime(100);
    source.onEvent({ type: "step_complete", runId: "r1", stepId: "review", iteration: 0, signal: null });
    vi.advanceTimersByTime(100);
    source.onEvent({ type: "gate_opened", runId: "r1", stepId: "approve-merge", gateId: "r1/approve-merge", prompt: "p" });
    vi.advanceTimersByTime(250);

    expect(frames).toEqual([{ v: 1, kind: "gate", runId: "r1", stepId: "approve-merge", at: "1970-01-01T00:00:00.000Z" }]);
  });

  it("a gate frame never carries the gate's prompt or summary", () => {
    const { frames, source } = started();

    source.onEvent({ type: "gate_opened", runId: "r1", stepId: "approve-merge", gateId: "r1/approve-merge", prompt: "SECRET-PROMPT", summary: "SECRET-SUMMARY" });
    vi.advanceTimersByTime(250);

    expect(frames).toHaveLength(1);
    expect(JSON.stringify(frames)).not.toMatch(/SECRET|prompt|summary/);
  });

  it("close leaves no poll or pending frame timer behind", () => {
    const { frames, source } = started();
    source.onEvent({ type: "step_started", runId: "r1", stepId: "review", iteration: 0 });

    source.close();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(frames).toEqual([]);
  });
});
