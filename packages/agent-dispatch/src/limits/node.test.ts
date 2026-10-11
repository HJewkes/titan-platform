import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LimitsConfigError } from "./index.js";
import { loadLimits, readGrants } from "./node.js";
import today from "./fixtures/limits-today.json" with { type: "json" };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limits-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

describe("loadLimits", () => {
  it("reads a limits block nested under a key of a host config", () => {
    const path = write("config.json", { worktreeBudget: 12, limits: today });
    expect(Object.keys(loadLimits(path, { key: "limits" }).limits.pools)).toEqual(["owner", "agents", "spare", "server"]);
  });

  it("reads a file that is the limits block itself", () => {
    expect(loadLimits(write("limits.json", today)).limits.version).toBe(1);
  });

  it("refuses a missing file, bad JSON or a missing key with a named error", () => {
    expect(() => loadLimits(join(dir, "absent.json"))).toThrow(LimitsConfigError);
    expect(() => loadLimits(write("bad.json", "{"))).toThrow(LimitsConfigError);
    expect(() => loadLimits(write("host.json", { worktreeBudget: 12 }), { key: "limits" })).toThrow(LimitsConfigError);
  });
});

describe("readGrants", () => {
  it("returns no grants when the file does not exist yet", () => {
    expect(readGrants(join(dir, "grants.json"))).toEqual({ grants: [], asked: [], ignored: [] });
  });

  it("keeps well-formed grants and ignores malformed ones", () => {
    const good = { pool: "agents", ceiling_five_hour: 100, until: "2026-10-12T17:40:00.000Z", question: "q-1" };
    const path = write("grants.json", { version: 1, grants: [good, { pool: "agents" }], asked: ["agents:x"] });
    const read = readGrants(path);

    expect(read.grants).toEqual([good]);
    expect(read.asked).toEqual(["agents:x"]);
    expect(read.ignored).toHaveLength(1);
  });

  it("refuses a grants file that is not JSON with a named error", () => {
    expect(() => readGrants(write("grants.json", "nope"))).toThrow(LimitsConfigError);
  });
});
