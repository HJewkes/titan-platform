import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeWorkClient, type ActiveWork } from "./active-work.js";
import { ANSWERS_FILE, createDecisionLog, type DecisionAnswer, type DecisionItem } from "./decision-log.js";
import { closedPort, startFakeDaemon } from "./test-support.js";
import { resolveConfig } from "./config.js";
import { createSources, fileUpstream, httpUpstream, humanOnlyFrom, probeUpstreams } from "./upstreams.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-upstreams-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("a daemon upstream", () => {
  it("is reachable when its /health answers, and reports the version", async () => {
    const daemon = await startFakeDaemon({ ok: true, version: "1.2.3", index: {} });
    try {
      const upstream = httpUpstream("work", "active-work daemon", daemon.port);
      expect(upstream.target).toBe(`http://127.0.0.1:${daemon.port}`);
      expect(await upstream.probe()).toEqual({ reachable: true, detail: "Version 1.2.3" });
    } finally {
      await daemon.close();
    }
  });

  it("is unreachable when nothing listens on its port", async () => {
    const upstream = httpUpstream("agents", "agent-chat broker", await closedPort());
    expect(await upstream.probe()).toEqual({ reachable: false, detail: "No answer from /health" });
  });
});

describe("a daemon upstream on a port another daemon holds", () => {
  it("does not read a session-miner as the active-work daemon, and names what answered", async () => {
    const miner = await startFakeDaemon({ ok: true, version: "0.4.0", sessions: 3, ftsOrphanRatio: 0 });
    try {
      const probe = await httpUpstream("work", "active-work daemon", miner.port).probe();
      expect(probe).toEqual({ reachable: false, detail: `Port ${miner.port} answers, but not as the active-work daemon (titan-miner 0.4.0)` });
    } finally {
      await miner.close();
    }
  });

  it("reads a broker-shaped answer as the agents upstream and a work-shaped one as not", async () => {
    const broker = await startFakeDaemon({ ok: true, version: "2.0.0", socket: "/tmp/broker.sock", sessions: 1, queue_open: 0 });
    try {
      expect(await httpUpstream("agents", "agent-chat broker", broker.port).probe()).toEqual({ reachable: true, detail: "Version 2.0.0" });
      expect((await httpUpstream("work", "active-work daemon", broker.port).probe()).reachable).toBe(false);
    } finally {
      await broker.close();
    }
  });
});

describe("a daemon upstream answering /health with a body that is not an object", () => {
  it.each([["a string", "hello"], ["a number", 5], ["true", true], ["an array", []]])("reads %s as unreachable and does not throw", async (_name, body) => {
    const daemon = await startFakeDaemon(body as unknown as Record<string, unknown>);
    try {
      for (const id of ["work", "agents"] as const) {
        const probe = await httpUpstream(id, "some daemon", daemon.port).probe();
        expect(probe).toEqual({ reachable: false, detail: `Port ${daemon.port} answers, but /health is not a JSON object` });
      }
    } finally {
      await daemon.close();
    }
  });
});

describe("a file upstream", () => {
  it("is reachable when the file exists, and reports its size without opening it", async () => {
    const file = path.join(dir, "graph.sqlite3");
    await writeFile(file, Buffer.alloc(2048));
    expect(await fileUpstream("sessions", "session graph", file).probe()).toEqual({ reachable: true, detail: "2.0 KiB on disk, not opened" });
  });

  it("is unreachable when the file is absent or is a directory", async () => {
    expect(await fileUpstream("sessions", "session graph", path.join(dir, "missing.sqlite3")).probe()).toEqual({ reachable: false, detail: "File not found" });
    expect(await fileUpstream("sessions", "session graph", dir).probe()).toEqual({ reachable: false, detail: "Not a file" });
  });

  it("shows a path under the home directory with a tilde", () => {
    expect(fileUpstream("sessions", "session graph", "/srv/tester/data/graph.sqlite3", "/srv/tester").target).toBe("~/data/graph.sqlite3");
    expect(fileUpstream("sessions", "session graph", "/var/graph.sqlite3", "/srv/tester").target).toBe("/var/graph.sqlite3");
  });
});

describe("probing every upstream", () => {
  it("reports each one, so one unreachable upstream does not hide the others", async () => {
    const daemon = await startFakeDaemon({ ok: true, index: {} });
    try {
      const health = await probeUpstreams([httpUpstream("work", "up", daemon.port), httpUpstream("agents", "down", await closedPort())]);
      expect(health.map(({ id, reachable, detail }) => ({ id, reachable, detail }))).toEqual([
        { id: "work", reachable: true, detail: "Answering" },
        { id: "agents", reachable: false, detail: "No answer from /health" },
      ]);
    } finally {
      await daemon.close();
    }
  });
});

describe("the active-work reads createSources builds", () => {
  it("go upstream once per window, and refresh behind an active-work relay frame", async () => {
    const asked: string[] = [];
    const daemon = await startFakeDaemon({ ok: true }, (command) => (asked.push(command), { sections: [], parse_errors: [] }));
    try {
      const sources = createSources({ ...resolveConfig({}, dir), activeWorkPort: daemon.port });

      await sources.activeWork.read("list");
      await sources.activeWork.read("list");
      expect(asked).toEqual(["list"]);

      sources.invalidation?.emit("active-work");
      await sources.activeWork.read("list");
      await vi.waitFor(() => expect(asked).toEqual(["list", "list"]));
    } finally {
      await daemon.close();
    }
  });

  it("refresh behind a write, since the write moved the tree", async () => {
    const asked: string[] = [];
    const daemon = await startFakeDaemon({ ok: true }, (command) => (asked.push(command), command === "loop.tier" ? { id: "loop-c", tier: "S", tier_rank: 1 } : { sections: [], parse_errors: [] }));
    try {
      const sources = createSources({ ...resolveConfig({}, dir), activeWorkPort: daemon.port });

      await sources.activeWork.read("list");
      await sources.activeWork.write?.("loop.tier", { id: "loop-c", tier: "S" });
      await sources.activeWork.read("list");

      await vi.waitFor(() => expect(asked).toEqual(["list", "loop.tier", "list"]));
    } finally {
      await daemon.close();
    }
  });
});

/** An active-work daemon over the wire whose inventory carries the given `withheld_from_agents`; undefined drops the field, as an older daemon would. */
async function daemonWith(rows: Record<string, boolean | undefined>): Promise<{ activeWork: ActiveWork; close(): Promise<void> }> {
  const stat = { files: 0, bytes: 0, newest_mtime: null };
  const classes = { tasks: stat, sessions: stat, notes: stat, sources: stat, nested_sources: stat };
  const initiatives = Object.entries(rows).map(([slug, withheld]) => ({
    slug, human_only: false, ...(withheld === undefined ? {} : { withheld_from_agents: withheld }), total: stat, classes, nested_dirs: [],
  }));
  const daemon = await startFakeDaemon({ status: "ok" }, () => ({ initiatives, totals: {}, human_only_known: true }));
  return { activeWork: activeWorkClient(daemon.port), close: () => daemon.close() };
}

describe("the decision log's visibility reader", () => {
  const item = (initiative: string): DecisionItem => ({
    id: `q-${initiative}`,
    sources: [{ system: "deposit", ref: `fixture-asker/${initiative}` }],
    kind: "decide",
    door: "two-way",
    summary: "Which way?",
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    recommended: { optionId: "a", by: "fixture-agent" },
    keys: [],
    initiative,
    personal: false,
  });
  const answered: DecisionAnswer = { optionId: "a", by: { class: "owner", id: "owner", channel: "console" }, at: "2026-03-04T10:00:00.000Z" };

  async function ledgerAfter(activeWork: ActiveWork, initiative: string): Promise<string> {
    const stateDir = path.join(dir, "state");
    await createDecisionLog({ stateDir, decisionsFile: null, humanOnly: humanOnlyFrom(activeWork) }).record(item(initiative), answered);
    return readFile(path.join(stateDir, ANSWERS_FILE), "utf8").catch(() => "");
  }

  async function withDaemon<T>(rows: Record<string, boolean | undefined>, run: (activeWork: ActiveWork) => Promise<T>): Promise<T> {
    const { activeWork, close } = await daemonWith(rows);
    try {
      return await run(activeWork);
    } finally {
      await close();
    }
  }

  it("keeps a withheld initiative out of answers.jsonl even when its brief is agent-visible", async () => {
    await withDaemon({ "garden-plan": true, "kiln-tools": false }, async (activeWork) => {
      expect(await ledgerAfter(activeWork, "garden-plan")).toBe("");
      expect(await ledgerAfter(activeWork, "kiln-tools")).toContain("kiln-tools");
    });
  });

  it("excludes every answer when the charter is unknown and every row is withheld", async () => {
    await withDaemon({ "garden-plan": true, "kiln-tools": true }, async (activeWork) => {
      expect(await ledgerAfter(activeWork, "kiln-tools")).toBe("");
    });
  });

  it("excludes a row that carries no withheld field, and a slug the inventory never listed", async () => {
    await withDaemon({ "kiln-tools": false, alpha: undefined }, async (activeWork) => {
      expect(await ledgerAfter(activeWork, "alpha")).toBe("");
      expect(await ledgerAfter(activeWork, "unlisted-slug")).toBe("");
    });
  });

  it("reads as unknown when no row carries the field, or the daemon is down", async () => {
    const down: ActiveWork = { read: () => Promise.reject(new Error("connection refused")) };

    await withDaemon({ alpha: undefined }, async (activeWork) => expect(await humanOnlyFrom(activeWork)()).toEqual({ known: false }));
    expect(await humanOnlyFrom(down)()).toEqual({ known: false });
  });
});
