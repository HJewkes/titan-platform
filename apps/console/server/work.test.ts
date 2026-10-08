import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "@titan-design/registry";
import { snapshotKey } from "@titan-design/rpc-client";
import { activeWorkClient } from "./active-work.js";
import { brokerReader } from "./broker.js";
import { fixtureAnswer, type FixtureOptions } from "./fixtures.js";
import { createConsoleRegistry, recordFirstPaint } from "./registry.js";
import { closedPort, startFakeDaemon, type FakeDaemon } from "./test-support.js";
import { readInitiative, readPortfolio, type Portfolio } from "./work.js";

/** The export records no agents call, so this broker is never read. */
const NO_AGENTS = { broker: brokerReader({ port: 1, tokenPath: "/nonexistent/ui.token" }), seatPrefixes: [] };
const NO_SESSIONS = { graphPath: "/nonexistent/graph.sqlite3" };

let daemon: FakeDaemon | undefined;
let calls: string[] = [];

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  calls = [];
});

/** A synthetic active-work daemon on loopback, reached the way the console reaches the real one. */
async function fakeActiveWork(options: FixtureOptions = {}) {
  daemon = await startFakeDaemon({ ok: true }, (command, args) => {
    calls.push(command);
    return fixtureAnswer(command, args, options);
  });
  return activeWorkClient(daemon.port);
}

describe("the portfolio", () => {
  it("lists every initiative with its task rollup, record counts and newest activity", async () => {
    const { initiatives, personalKnown } = await readPortfolio(await fakeActiveWork());
    expect(personalKnown).toBe(true);
    expect(initiatives.map((row) => row.slug)).toEqual(["orbit-relay", "lantern-docs", "kiln-tools", "garden-plan", "atlas-archive"]);
    expect(initiatives[0]).toMatchObject({
      state: "focused",
      rank: 1,
      shipTarget: "2031-Q2",
      openTasks: 3,
      severityCounts: { critical: 1, high: 1, medium: 0, low: 1 },
      topTask: { id: "OR-12", title: "Retry a dropped handshake with backoff" },
      notes: 2,
      sources: 3,
      sessions: 2,
      newestActivity: "2031-03-04T16:20:00.000Z",
    });
  });

  it("flags a personal initiative and still shows it", async () => {
    const { initiatives } = await readPortfolio(await fakeActiveWork());
    expect(initiatives.filter((row) => row.personal).map((row) => row.slug)).toEqual(["garden-plan"]);
  });

  it("flags an initiative as personal when active-work reports the charter unread but leaves human_only false", async () => {
    daemon = await startFakeDaemon({ ok: true }, (command, args) => {
      const answer = fixtureAnswer(command, args) as { initiatives?: Array<{ human_only: boolean }>; human_only_known?: boolean };
      return command === "inventory" ? { ...answer, human_only_known: false, initiatives: answer.initiatives!.map((entry) => ({ ...entry, human_only: false })) } : answer;
    });
    const activeWork = activeWorkClient(daemon.port);
    expect((await readPortfolio(activeWork)).initiatives.every((row) => row.personal)).toBe(true);
    expect((await readInitiative(activeWork, "orbit-relay")).initiative.personal).toBe(true);
    expect((await readPortfolio(activeWork, { excludePersonal: true })).initiatives).toEqual([]);
  });

  it("flags every initiative when active-work cannot say which are personal", async () => {
    const { initiatives, personalKnown } = await readPortfolio(await fakeActiveWork({ humanOnlyKnown: false }));
    expect(personalKnown).toBe(false);
    expect(initiatives.every((row) => row.personal)).toBe(true);
  });

  it("fails with an unavailable code when the active-work daemon is down", async () => {
    await expect(readPortfolio(activeWorkClient(await closedPort()))).rejects.toMatchObject({ code: EXIT.UNAVAILABLE });
  });
});

describe("an initiative", () => {
  it("carries its brief, open tasks, recent sessions, open loops, notes and sources", async () => {
    const detail = await readInitiative(await fakeActiveWork(), "orbit-relay");
    expect(detail.initiative).toMatchObject({ slug: "orbit-relay", state: "focused", personal: false });
    expect(detail.brief.body.startsWith("\n# Orbit relay")).toBe(true);
    expect(detail.tasks.map((task) => task.id)).toEqual(["OR-12", "OR-14", "OR-9"]);
    expect(detail.sessions[0]).toEqual({ filename: "2031-03-04-1500-relay-retry.md", started: "2031-03-04T15:00:00Z", ended: "2031-03-04T16:20:00Z", track: "canonical", title: "Handshake retry spike" });
    expect(detail.loops).toEqual([expect.objectContaining({ kind: "task", targetRef: "OR-12" })]);
    expect(detail.notes.map((note) => note.id)).toEqual(["orbit-relay:notes:2031-03-03-backoff-ceiling.md", "orbit-relay:notes:2031-02-27-station-clock-skew.md"]);
    expect(detail.sources.map((source) => source.filename)).toEqual(["deepdive-routing-table.md", "pr-41-handshake.md"]);
    expect(detail.nestedSources).toBe(1);
  });

  it("caps the open tasks at the limit, keeps the most urgent, and reports the full count", async () => {
    const detail = await readInitiative(await fakeActiveWork(), "orbit-relay", { taskLimit: 2 });
    expect(detail.tasks.map((task) => task.id)).toEqual(["OR-12", "OR-14"]);
    expect(detail.openTasks).toBe(3);
  });

  it("sends no absolute file path to the browser", async () => {
    const detail = await readInitiative(await fakeActiveWork(), "orbit-relay");
    expect(JSON.stringify(detail)).not.toContain("/synthetic/");
  });

  it("refuses a slug active-work does not list before reading any file", async () => {
    const activeWork = await fakeActiveWork();
    await expect(readInitiative(activeWork, "../elsewhere")).rejects.toMatchObject({ code: EXIT.NOINPUT });
    expect(calls).not.toContain("source.read");
  });
});

describe("an export", () => {
  const exported = async (options: FixtureOptions = {}) =>
    createConsoleRegistry({ upstreams: [], agents: NO_AGENTS, sessions: NO_SESSIONS, activeWork: await fakeActiveWork(options), work: { excludePersonal: true } });

  it("records the portfolio without the personal initiative", async () => {
    const snapshot = await recordFirstPaint(await exported());
    const envelope = snapshot.calls[snapshotKey("work.portfolio", {})] as { ok: true; data: Portfolio };
    expect(envelope.data.initiatives.map((row) => row.slug)).toEqual(["orbit-relay", "lantern-docs", "kiln-tools", "atlas-archive"]);
    expect(JSON.stringify(snapshot)).not.toContain("garden-plan");
  });

  it("records no initiative at all when active-work cannot say which are personal", async () => {
    const snapshot = await recordFirstPaint(await exported({ humanOnlyKnown: false }));
    const envelope = snapshot.calls[snapshotKey("work.portfolio", {})] as { ok: true; data: Portfolio };
    expect(envelope.data.initiatives).toEqual([]);
  });

  it("refuses the detail of a personal initiative", async () => {
    await expect(readInitiative(await fakeActiveWork(), "garden-plan", { excludePersonal: true })).rejects.toThrow(/left out of exports/);
    expect(calls).not.toContain("source.read");
  });
});
