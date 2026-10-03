import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closedPort, startFakeDaemon } from "./test-support.js";
import { fileUpstream, httpUpstream, probeUpstreams } from "./upstreams.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-upstreams-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("a daemon upstream", () => {
  it("is reachable when its /health answers, and reports the version", async () => {
    const daemon = await startFakeDaemon({ ok: true, version: "1.2.3" });
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
    const daemon = await startFakeDaemon({ ok: true });
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
