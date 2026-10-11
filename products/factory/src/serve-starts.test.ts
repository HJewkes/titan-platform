import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordServeStart, serveStartsHealth } from "./serve-starts.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-starts-"));
  dirs.push(dir);
  return dir;
}

const at = (iso: string): Date => new Date(iso);

describe("serve start counts", () => {
  it("counts every start in the state directory and the unclean ones apart", () => {
    const dir = stateDir();

    recordServeStart(dir, { unclean: false, now: at("2026-10-08T01:00:00.000Z") });
    const second = recordServeStart(dir, { unclean: true, now: at("2026-10-08T02:00:00.000Z") });

    expect(second).toMatchObject({ startedAt: "2026-10-08T02:00:00.000Z", restartCount: 2, uncleanStartsTotal: 1, restartsToday: 2 });
  });

  it("starts the day's count again on a new UTC day and keeps the totals", () => {
    const dir = stateDir();
    recordServeStart(dir, { unclean: true, now: at("2026-10-07T23:59:00.000Z") });

    const next = recordServeStart(dir, { unclean: false, now: at("2026-10-08T00:01:00.000Z") });

    expect(next).toMatchObject({ restartCount: 2, uncleanStartsTotal: 1, restartsToday: 1 });
  });

  it("starts over from zero when the file is unreadable", () => {
    const dir = stateDir();
    writeFileSync(join(dir, "serve-starts.json"), "{not json");

    expect(recordServeStart(dir, { unclean: false, now: at("2026-10-08T01:00:00.000Z") })).toMatchObject({ restartCount: 1, uncleanStartsTotal: 0 });
  });

  it("reports uptime and no starts today once the day has turned", () => {
    const start = recordServeStart(stateDir(), { unclean: false, now: at("2026-10-08T23:00:00.000Z") });

    const health = serveStartsHealth(start, at("2026-10-09T00:30:00.500Z"));

    expect(health).toEqual({ startedAt: "2026-10-08T23:00:00.000Z", uptimeSeconds: 5400, restartCount: 1, uncleanStartsTotal: 0, restartsToday: 0 });
  });
});
