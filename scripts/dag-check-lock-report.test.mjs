import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { busyLogPath, holdLogPath } from "./dag-check-lock.mjs";
import { buildReport, formatReport, parseSince } from "./dag-check-lock-report.mjs";

const SCRIPT = new URL("./dag-check-lock-report.mjs", import.meta.url).pathname;
const HOUR = 60 * 60 * 1000;
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function lockDir() {
  const root = mkdtempSync(join(tmpdir(), "dag-check-lock-report-"));
  roots.push(root);
  return join(root, "dag-check.lock");
}

function busy(dir, owner, at) {
  appendFileSync(busyLogPath(dir), `${JSON.stringify({ at, owner, check: "dag:check", ahead: 0, reason: "timeout" })}\n`);
}

function hold(dir, acquiredAt) {
  appendFileSync(holdLogPath(dir), `${JSON.stringify({ acquiredAt, releasedAt: acquiredAt + 1, exit: 0 })}\n`);
}

describe("buildReport", () => {
  it("counts each owner's streak separately and resets it at a hold", () => {
    const dir = lockDir();
    const now = Date.now();
    [10, 20, 30].forEach((seconds) => busy(dir, "aaa", now - HOUR + seconds * 1000));
    busy(dir, "bbb", now - HOUR + 15_000);
    hold(dir, now - HOUR + 25_000);
    busy(dir, "bbb", now - HOUR + 40_000);

    const rows = Object.fromEntries(buildReport(dir, now - 2 * HOUR).map((row) => [row.owner, row]));

    expect(rows.aaa).toMatchObject({ longestStreak: 2, busy: 3, holds: 1 });
    expect(rows.bbb).toMatchObject({ longestStreak: 1, busy: 2, holds: 1 });
  });

  it("leaves out lines older than the window", () => {
    const dir = lockDir();
    const now = Date.now();
    busy(dir, "old", now - 5 * HOUR);
    hold(dir, now - 5 * HOUR);
    busy(dir, "new", now - 1000);

    expect(buildReport(dir, now - 2 * HOUR)).toEqual([{ owner: "new", longestStreak: 1, busy: 1, holds: 0 }]);
  });

  it("returns no rows when the logs are missing", () => {
    expect(buildReport(lockDir(), 0)).toEqual([]);
  });
});

describe("parseSince", () => {
  it("reads a count and unit", () => {
    expect(parseSince("2h")).toBe(2 * HOUR);
    expect(() => parseSince("soon")).toThrow(/--since/);
  });
});

describe("command line", () => {
  it("prints only the header and exits 0 for a missing lock dir", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--since", "2h", "--lock-dir", lockDir()], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(formatReport([]));
  });
});
