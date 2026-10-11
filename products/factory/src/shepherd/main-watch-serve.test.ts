import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { fakeSha, successRun } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFactoryServer, type FactoryServer } from "../serve.js";
import { REPO } from "../test-support/land.js";
import { shepherdFixture, type ShepherdFixture } from "../test-support/shepherd.js";
import type { MainWatchPorts } from "./main-watch.js";
import type { SeatBook } from "./seats.js";

const BOOK: SeatBook = { seats: [{ name: "alpha-coord", remotes: [REPO], paths: {}, grants: [] }], denied: [] };
const dirs: string[] = [];
afterEach(() => void dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function serve(fixture: ShepherdFixture, dbPath: string, mainWatch: MainWatchPorts): Promise<FactoryServer> {
  return startFactoryServer({ dbPath, workflows: fixture.workflows, routes: fixture.routes, port: 0, logger: silentLogger, resyncOnStart: false, github: { status: () => "ok", refresh: async () => undefined }, mainWatch });
}

describe("serve's main CI watch", () => {
  it("sends a seat-merge's red main one event, and none again after serve restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "main-watch-serve-"));
    dirs.push(dir);
    const dbPath = join(dir, "factory.sqlite3");
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
});
