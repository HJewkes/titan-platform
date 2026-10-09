import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "@titan-design/registry";
import { snapshotKey } from "@titan-design/rpc-client";
import { activeWorkClient } from "./active-work.js";
import { brokerReader } from "./broker.js";
import { fixtureActiveWork, fixtureAnswer, type FixtureOptions } from "./fixtures.js";
import { createConsoleRegistry, recordFirstPaint } from "./registry.js";
import { closedPort, startFakeDaemon, type FakeDaemon } from "./test-support.js";
import { readInitiative, readNotes, readPortfolio, readRecord, searchRecords, type Portfolio } from "./work.js";

/** The export records no agents call, so this broker is never read. */
const NO_AGENTS = { broker: brokerReader({ port: 1, tokenPath: "/nonexistent/ui.token" }), eventsDbPath: "/nonexistent/events.db", seatPrefixes: [] };
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

  it("carries each brief's task prefix, and none for a brief that names none", async () => {
    const { initiatives } = await readPortfolio(await fakeActiveWork());
    expect(Object.fromEntries(initiatives.map((row) => [row.slug, row.taskPrefix]))).toEqual({
      "orbit-relay": "OR",
      "lantern-docs": "LD",
      "kiln-tools": "KT",
      "garden-plan": "GP",
      "atlas-archive": undefined,
    });
  });

  it("leaves the prefix out when a brief cannot be read, and still lists the initiative", async () => {
    daemon = await startFakeDaemon({ ok: true }, (command, args) => {
      if (command === "source.read" && args.slug === "kiln-tools") throw new Error("no brief");
      return fixtureAnswer(command, args);
    });
    const { initiatives } = await readPortfolio(activeWorkClient(daemon.port));
    expect(initiatives.find((row) => row.slug === "kiln-tools")).not.toHaveProperty("taskPrefix");
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

describe("the knowledge reads", () => {
  it("lists notes and top-level sources across initiatives, each by its ref, newest change first", async () => {
    const { records } = await readNotes(await fakeActiveWork());
    expect(records.map((row) => row.ref)).toEqual([
      "note:orbit-relay/2031-03-03-backoff-ceiling.md",
      "note:lantern-docs/2031-02-28-chapter-order.md",
      "note:orbit-relay/2031-02-27-station-clock-skew.md",
      "source:orbit-relay/pr-41-handshake.md",
      "source:orbit-relay/deepdive-routing-table.md",
      "source:kiln-tools/deepdive-cone-chart.md",
      "note:garden-plan/2031-01-19-seed-list.md",
    ]);
    expect(records[1]).toMatchObject({ kind: "note", slug: "lantern-docs", type: "plan", changed: "2031-02-28" });
  });

  it("leaves personal records out when personal initiatives are excluded", async () => {
    const { records } = await readNotes(await fakeActiveWork(), { excludePersonal: true });
    expect(records.map((row) => row.slug)).not.toContain("garden-plan");
    expect(records).toHaveLength(6);
  });

  it("reads a note by ref with its frontmatter fields and body", async () => {
    const record = await readRecord(await fakeActiveWork(), "note:orbit-relay/2031-03-03-backoff-ceiling.md");
    expect(record).toMatchObject({ kind: "note", slug: "orbit-relay", file: "2031-03-03-backoff-ceiling.md", title: "Cap the backoff at thirty seconds", type: "decision", truncated: false });
    expect(record.body).toContain("stop growing at thirty seconds");
  });

  it("reads a source by ref under the initiative's sources directory, titled by its first heading", async () => {
    const record = await readRecord(await fakeActiveWork(), "source:orbit-relay/pr-41-handshake.md");
    expect(record).toMatchObject({ kind: "source", title: "Handshake rewrite", type: null, created: null });
    expect(record.body.startsWith("# Handshake rewrite")).toBe(true);
  });

  it("answers no-input for a record active-work cannot find", async () => {
    await expect(readRecord(fixtureActiveWork(), "note:orbit-relay/missing.md")).rejects.toMatchObject({ code: EXIT.NOINPUT });
  });

  it("refuses a ref that steps out of the sources directory before reading any file", async () => {
    await expect(readRecord(await fakeActiveWork(), "source:orbit-relay/../brief.md")).rejects.toMatchObject({ code: EXIT.DATAERR });
    expect(calls).toEqual([]);
  });

  it("refuses a personal record before reading it when personal initiatives are excluded", async () => {
    await expect(readRecord(await fakeActiveWork(), "note:garden-plan/2031-01-19-seed-list.md", { excludePersonal: true })).rejects.toMatchObject({ code: EXIT.NOINPUT });
    expect(calls).not.toContain("note.read");
  });

  it("returns search hits by ref, without personal ones when those are excluded", async () => {
    const activeWork = await fakeActiveWork();
    const all = await searchRecords(activeWork, "s");
    const kept = await searchRecords(activeWork, "s", { excludePersonal: true });
    expect(all.hits.map((hit) => hit.initiative)).toContain("garden-plan");
    expect(kept.hits.map((hit) => hit.initiative)).not.toContain("garden-plan");
    expect(kept.hits[0]).toEqual({ ref: expect.stringMatching(/^(note|source):/), class: expect.any(String), initiative: expect.any(String), title: expect.any(String), excerpt: expect.any(String) });
  });
});

describe("an export", () => {
  const exported = async (options: FixtureOptions = {}) =>
    createConsoleRegistry({ upstreams: [], agents: NO_AGENTS, sessions: NO_SESSIONS, inbox: { dir: "/nonexistent/inbox" }, activeWork: await fakeActiveWork(options), work: { excludePersonal: true } });

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
