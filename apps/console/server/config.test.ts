import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONSOLE_PORT, resolveConfig } from "./config.js";

const HOME = "/srv/tester";

describe("console config", () => {
  it("defaults to its own port and the upstreams' usual loopback ports", () => {
    const config = resolveConfig({}, HOME);
    expect(config.port).toBe(DEFAULT_CONSOLE_PORT);
    expect(config.port).not.toBe(7400);
    expect(config).toMatchObject({ activeWorkPort: 7400, agentChatPort: 7600, stateDir: path.join(HOME, ".local/state/titan-console") });
  });

  it("refuses a port that belongs to an upstream daemon", () => {
    expect(() => resolveConfig({ TITAN_CONSOLE_PORT: "7400" }, HOME)).toThrow(/port of its own/);
    expect(() => resolveConfig({ TITAN_CONSOLE_PORT: "7700", TITAN_CONSOLE_AGENT_CHAT_PORT: "7700" }, HOME)).toThrow(/port of its own/);
  });

  it("refuses a port that is not a number instead of falling back", () => {
    expect(() => resolveConfig({ TITAN_CONSOLE_PORT: "75oo" }, HOME)).toThrow(/TITAN_CONSOLE_PORT must be a port number/);
    expect(() => resolveConfig({ TITAN_CONSOLE_ACTIVE_WORK_PORT: "70000" }, HOME)).toThrow(/TITAN_CONSOLE_ACTIVE_WORK_PORT/);
  });

  it("finds the session graph under active-work's root unless a path is given", () => {
    expect(resolveConfig({ ACTIVE_ROOT: "~/work" }, HOME).sessionGraphPath).toBe(path.join(HOME, "work", ".miner", "graph.sqlite3"));
    expect(resolveConfig({ ACTIVE_ROOT: "~/work", TITAN_CONSOLE_SESSION_GRAPH: "~/graphs/g.sqlite3" }, HOME).sessionGraphPath).toBe(
      path.join(HOME, "graphs", "g.sqlite3"),
    );
  });
});
