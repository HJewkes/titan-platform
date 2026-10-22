import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { silentLogger, type Logger } from "@titan-design/daemon";
import { fakeSha, successRun } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFactoryServer, type FactoryServer } from "../serve.js";
import { REPO } from "../test-support/land.js";
import { callCommand, shepherdFixture, type ShepherdFixture } from "../test-support/shepherd.js";
import { openMainWatch, type MainWatchPorts } from "./main-watch.js";
import type { SeatBook } from "./seats.js";

const BOOK: SeatBook = { seats: [{ name: "alpha-coord", remotes: [REPO], paths: {}, grants: [] }], denied: [] };
const dirs: string[] = [];
afterEach(() => void dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function serve(fixture: ShepherdFixture, dbPath: string, mainWatch: MainWatchPorts, logger: Logger = silentLogger): Promise<FactoryServer> {
  return startFactoryServer({ dbPath, workflows: fixture.workflows, routes: fixture.routes, port: 0, logger, resyncOnStart: false, github: { status: () => "ok", refresh: async () => undefined }, mainWatch });
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "main-watch-serve-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

describe("serve's main CI watch", () => {
  it("sends a seat-merge's red main one event, and none again after serve restarts", async () => {
    const dbPath = tempDb();
    const fixture = shepherdFixture({ seats: BOOK });
    const sha = fakeSha("seat-merge");
    const at = new Date(Date.now() + 60_000).toISOString();
    fixture.fake.history.push({ sha, message: "Fix the parser (#41)", committedAt: at });
    fixture.fake.addPr({ number: 41, headSha: fakeSha("head-41"), headRef: "agent-chat/ac-fix-parser", state: "closed", merged: true, mergeSha: sha });
    fixture.fake.setRuns(sha, [successRun("validate", 1, at, "failure"), successRun("dag-check", 2, at)]);
    const sent: { seat: string; text: string }[] = [];
    const ports: MainWatchPorts = { hubSeat: () => undefined, send: async (seat, text) => void sent.push({ seat, text }) };
    const lists = (): number => fixture.fake.calls.filter((call) => call === "listCommits").length;

    const first = await serve(fixture, dbPath, ports);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await first.close();
    const before = lists();
    const second = await serve(fixture, dbPath, ports);
    await vi.waitFor(() => expect(lists()).toBeGreaterThan(before));
    await second.close();

    expect(sent).toEqual([{ seat: "alpha-coord", text: expect.stringContaining(`at ${sha} after PR #41. Failing: validate.`) }]);
  });

  it("sends a red merge to the repo's red seat while the run's merge policy keeps the seat file's seat", async () => {
    const fixture = shepherdFixture({ seats: BOOK, frozen: true });
    const sent: string[] = [];
    const ports: MainWatchPorts = { hubSeat: () => undefined, redSeat: () => "factory-coord", send: async (seat) => void sent.push(seat) };
    const head = fakeSha("head-42");
    fixture.fake.addPr({ number: 42, headSha: head, headRef: "agent-chat/ac-fix-lexer" });
    const server = await serve(fixture, tempDb(), ports);
    const registered = await callCommand<{ runId: string }>(server.host, fixture.routes, "shepherd.register", { repo: REPO, pr: 42, task: "demo/T-1", implementer: "ac-fix-lexer" });
    expect(registered.ok).toBe(true);
    const sha = fakeSha("merge-42");
    const at = new Date(Date.now() + 60_000).toISOString();
    fixture.fake.history.push({ sha, message: "Fix the lexer (#42)", committedAt: at });
    fixture.fake.setRuns(sha, [successRun("validate", 1, at, "failure")]);
    const watch = openMainWatch(fixture.routes.shepherd!, ports, dirname(tempDb()), silentLogger);

    await watch.tick();
    const policySeat = fixture.routes.shepherd!.store.get().byPr(REPO, 42)?.policy.seat;
    watch.close();
    await server.close();

    expect(sent).toEqual(["factory-coord"]);
    expect(policySeat).toBe("alpha-coord");
  });

  it("alarms once per change in the dead seats, not on every sweep, and again once a seat that came back dies", async () => {
    const fixture = shepherdFixture({ seats: BOOK });
    const errors: string[] = [];
    const logger: Logger = { ...silentLogger, error: (fields) => void errors.push(String(fields.seat)) };
    const live = { names: new Set<string>() };
    const ports: MainWatchPorts = { hubSeat: () => undefined, send: async () => undefined, liveNames: async () => live.names };
    const watch = openMainWatch(fixture.routes.shepherd!, ports, dirname(tempDb()), logger);

    await watch.tick();
    await watch.tick();
    live.names = new Set(["alpha-coord"]);
    await watch.tick();
    live.names = new Set();
    await watch.tick();
    watch.close();

    expect(errors).toEqual(["alpha-coord", "alpha-coord"]);
  });

  it("alarms for a newly dead seat when another comes back in the same sweep, so the count of dead seats stays the same", async () => {
    const fixture = shepherdFixture({ seats: BOOK });
    const errors: string[] = [];
    const logger: Logger = { ...silentLogger, error: (fields) => void errors.push(String(fields.seat)) };
    const live = { names: new Set(["hub-coord"]) };
    const ports: MainWatchPorts = { hubSeat: () => "hub-coord", send: async () => undefined, liveNames: async () => live.names };
    const watch = openMainWatch(fixture.routes.shepherd!, ports, dirname(tempDb()), logger);

    await watch.tick();
    live.names = new Set(["alpha-coord"]);
    await watch.tick();
    watch.close();

    expect(errors).toEqual(["alpha-coord", "hub-coord"]);
  });

  it("warns once that it skipped the dead-seat check while the roster cannot be read, and again after a read succeeds", async () => {
    const fixture = shepherdFixture({ seats: BOOK });
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (_fields, message) => void warnings.push(message) };
    const roster = { down: true };
    const liveNames = async () => (roster.down ? Promise.reject(new Error("broker down")) : new Set(["alpha-coord"]));
    const watch = openMainWatch(fixture.routes.shepherd!, { hubSeat: () => undefined, send: async () => undefined, liveNames }, dirname(tempDb()), logger);

    await watch.tick();
    await watch.tick();
    roster.down = false;
    await watch.tick();
    roster.down = true;
    await watch.tick();
    watch.close();

    expect(warnings.filter((message) => message.includes("skipped its dead-seat check"))).toHaveLength(2);
  });

  it("logs an alarm at startup when the seat a repo's red events go to has no live session", async () => {
    const fixture = shepherdFixture({ seats: BOOK });
    const errors: { fields: Record<string, unknown>; message: string }[] = [];
    const logger: Logger = { ...silentLogger, error: (fields, message) => void errors.push({ fields, message }) };
    const reads = { count: 0 };
    const ports: MainWatchPorts = { hubSeat: () => "hub-coord", send: async () => undefined, liveNames: async () => (reads.count++, new Set(["hub-coord"])) };

    const server = await serve(fixture, tempDb(), ports, logger);
    await vi.waitFor(() => expect(reads.count).toBeGreaterThan(0));
    await server.close();

    expect(errors).toEqual([
      { fields: { seat: "alpha-coord", repos: [REPO] }, message: "main CI watch ALARM: red events go to seat alpha-coord, which no live agent-chat session holds" },
    ]);
  });
});
