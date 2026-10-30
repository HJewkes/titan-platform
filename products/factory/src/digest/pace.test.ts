import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pacePath, readPacePools } from "./pace.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function paceFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-pace-"));
  dirs.push(dir);
  writeFileSync(join(dir, "pace.json"), body);
  return join(dir, "pace.json");
}

describe("readPacePools", () => {
  it("reads one line per pool from the watchdog's pass, ignoring the fields the digest does not show", () => {
    const pools = {
      "pool-a": { sevenDay: 41, fiveHour: 9, stale: false, behind: 3, members: ["pool-c"] },
      "pool-b": { sevenDay: 70, stale: true, ageSeconds: 9000 },
    };

    expect(readPacePools(paceFile(JSON.stringify({ at: 0, pools })))).toEqual([
      { pool: "pool-a", sevenDay: 41, fiveHour: 9, stale: false },
      { pool: "pool-b", sevenDay: 70, stale: true },
    ]);
  });

  it("keeps a pool the watchdog wrote with no reading, showing it with no numbers", () => {
    const pools = {
      "pool-a": { sevenDay: 41, fiveHour: 9, stale: false },
      "pool-new": { sevenDay: null, fiveHour: null, stale: true, level: "no_reading" },
    };

    expect(readPacePools(paceFile(JSON.stringify({ at: 0, pools })))).toEqual([
      { pool: "pool-a", sevenDay: 41, fiveHour: 9, stale: false },
      { pool: "pool-new", stale: true },
    ]);
  });

  it("throws on a file with no pools, so the digest shows a gap rather than an empty section", () => {
    expect(() => readPacePools(paceFile(JSON.stringify({ at: 0 })))).toThrow(/unexpected pace.json/);
  });

  it("finds the file under AGENT_CHAT_HOME", () => {
    expect(pacePath({ AGENT_CHAT_HOME: "/srv/broker" })).toBe(join("/srv/broker", "pace.json"));
  });
});
