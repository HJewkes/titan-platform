import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readShepherdLimits, resetLimitsReadLog } from "./limits-read.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "limits-read-"));
  mkdirSync(home, { recursive: true });
  resetLimitsReadLog();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const writeConfig = (value: unknown): void => writeFileSync(join(home, "config.json"), JSON.stringify(value));
const block = (shepherd: unknown) => ({ limits: { version: 1, pools: {}, shepherd } });

describe("readShepherdLimits", () => {
  it("maps the shepherd keys onto spawn limits", () => {
    writeConfig(block({ spawn_gate: { load5: 40, build_load5: 30 }, review: { max_concurrent: 5 } }));

    expect(readShepherdLimits({ AGENT_CHAT_HOME: home })).toEqual({ load5: 40, buildLoad5: 30, maxConcurrentReviews: 5 });
  });

  it("returns nothing and stays quiet when there is no config file or no shepherd key", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readShepherdLimits({ AGENT_CHAT_HOME: home })).toEqual({});
    writeConfig(block(undefined));
    expect(readShepherdLimits({ AGENT_CHAT_HOME: home })).toEqual({});
    expect(log).not.toHaveBeenCalled();
  });

  it("stays quiet for a config file with no limits block", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    writeConfig({ worktreeBudget: 12 });

    expect(readShepherdLimits({ AGENT_CHAT_HOME: home })).toEqual({});
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a limits block that is not an object, though its message also names a block", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    writeConfig({ limits: "has no limits block" });

    expect(readShepherdLimits({ AGENT_CHAT_HOME: home })).toEqual({});
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("falls back to nothing and logs once for a malformed shepherd block", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    writeConfig(block({ review: { max_concurrent: -3 } }));

    expect(readShepherdLimits({ AGENT_CHAT_HOME: home })).toEqual({});
    expect(readShepherdLimits({ AGENT_CHAT_HOME: home })).toEqual({});
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("falls back and logs once for a config file that is not JSON", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(home, "config.json"), "{nope");

    expect(readShepherdLimits({ AGENT_CHAT_HOME: home })).toEqual({});
    expect(log).toHaveBeenCalledTimes(1);
  });
});
