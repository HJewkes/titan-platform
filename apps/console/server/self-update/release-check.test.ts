import { describe, expect, it } from "vitest";
import { flushRelease, type FlushPorts } from "./release-check.js";

const SHA = "b".repeat(40);
const OTHER = "c".repeat(40);
const RELEASE = `/srv/console/releases/${SHA}`;
const DIST = `${RELEASE}/apps/console/dist`;

interface Fake {
  ports: FlushPorts;
  files: Map<string, string>;
  calls: string[];
  lines: string[];
}

function fakePorts(syncFails?: string): Fake {
  const files = new Map([
    [`${DIST}/cli.js`, "#!/usr/bin/env node"],
    [`${DIST}/index.html`, "<!doctype html>"],
    [`${DIST}/build-info.json`, JSON.stringify({ sha: SHA, builtAt: "2031-03-05T11:58:00.000Z", dirty: false })],
  ]);
  const calls: string[] = [];
  const lines: string[] = [];
  let clock = 1_000;
  const ports: FlushPorts = {
    syncFs: async (dir) => (calls.push(`sync -f ${dir}`), (clock += 120), syncFails),
    fileSize: (file) => (calls.push(`stat ${file}`), files.get(file)?.length),
    readFile: (file) => files.get(file),
    log: (line) => void lines.push(line),
    now: () => clock,
  };
  return { ports, files, calls, lines };
}

describe("flushing a release before current may name it", () => {
  // TP-4638: a power loss after the swap left every file in the new release at 0 bytes.
  it("syncs the release's filesystem before reading the build back, and logs what the flush cost", async () => {
    const fake = fakePorts();

    expect(await flushRelease(fake.ports, RELEASE, SHA)).toBeUndefined();

    expect(fake.calls[0]).toBe(`sync -f ${RELEASE}`);
    expect(fake.calls.slice(1)).toEqual([`stat ${DIST}/cli.js`, `stat ${DIST}/index.html`]);
    expect(fake.lines).toEqual([`flushed ${RELEASE} to disk in 120 ms`]);
  });

  it("refuses a release whose bin is empty or whose page is missing", async () => {
    const emptyBin = fakePorts();
    emptyBin.files.set(`${DIST}/cli.js`, "");
    const noPage = fakePorts();
    noPage.files.delete(`${DIST}/index.html`);

    expect(await flushRelease(emptyBin.ports, RELEASE, SHA)).toBe(`${RELEASE} is not a whole build after its flush: apps/console/dist/cli.js is empty`);
    expect(await flushRelease(noPage.ports, RELEASE, SHA)).toBe(`${RELEASE} is not a whole build after its flush: apps/console/dist/index.html is missing`);
  });

  it("refuses a release whose build-info names another sha, or does not parse", async () => {
    const misstamped = fakePorts();
    misstamped.files.set(`${DIST}/build-info.json`, JSON.stringify({ sha: OTHER }));
    const emptied = fakePorts();
    emptied.files.set(`${DIST}/build-info.json`, "");

    expect(await flushRelease(misstamped.ports, RELEASE, SHA)).toMatch(new RegExp(`build-info.json names ${OTHER}, not ${SHA}$`));
    expect(await flushRelease(emptied.ports, RELEASE, SHA)).toMatch(new RegExp(`build-info.json names no sha, not ${SHA}$`));
  });

  it("refuses without reading the build back when the sync fails", async () => {
    const fake = fakePorts("sync: error syncing: Input/output error");

    expect(await flushRelease(fake.ports, RELEASE, SHA)).toBe(`sync -f ${RELEASE} failed: sync: error syncing: Input/output error`);
    expect(fake.calls).toEqual([`sync -f ${RELEASE}`]);
  });
});
