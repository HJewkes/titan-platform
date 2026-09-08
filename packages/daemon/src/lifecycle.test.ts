import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  daemonPaths,
  getProcessCommand,
  isProcessAlive,
  probeHealth,
  readPidFile,
  removePidFile,
  writePidFile,
  type DaemonPaths,
} from "./lifecycle.js";

const meta = { port: 7400, version: "1.2.3", started: "2026-09-08T00:00:00.000Z" };

let stateDir: string;
let paths: DaemonPaths;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "titan-lifecycle-"));
  paths = daemonPaths(path.join(stateDir, "nested"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("pid file", () => {
  it("round-trips the pid and metadata, creating the state directory", async () => {
    await writePidFile(paths, 4242, meta);

    expect(await readPidFile(paths)).toEqual({ pid: 4242, meta });
    expect((await readFile(paths.pidFile, "utf8")).trim()).toBe("4242");
  });

  it("reads null when no daemon has written one", async () => {
    expect(await readPidFile(paths)).toBeNull();
  });

  it("falls back to placeholder metadata when only the pid file exists", async () => {
    await writePidFile(paths, 4242, meta);
    await rm(paths.metaFile);

    expect(await readPidFile(paths)).toEqual({ pid: 4242, meta: { port: 0, version: "unknown", started: "" } });
  });

  it("refuses to remove a pid file owned by a different process", async () => {
    await writePidFile(paths, 4242, meta);

    expect(await removePidFile(paths, 9999)).toBe(false);
    expect(await readPidFile(paths)).not.toBeNull();
  });

  it("removes both files when the pid matches", async () => {
    await writePidFile(paths, 4242, meta);

    expect(await removePidFile(paths, 4242)).toBe(true);
    expect(await readPidFile(paths)).toBeNull();
  });
});

describe("process probes", () => {
  it("reports this process alive and an impossible pid dead", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  it("names the command running at this pid", () => {
    expect(getProcessCommand(process.pid)).toContain("node");
    expect(getProcessCommand(-1)).toBeNull();
  });

  it("returns null when nothing answers the health probe", async () => {
    expect(await probeHealth(1, { timeoutMs: 200 })).toBeNull();
  });
});
