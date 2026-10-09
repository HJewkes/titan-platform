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

  it("lets ACTIVE_ROOT override the default session graph location", () => {
    expect(resolveConfig({ ACTIVE_ROOT: "/var/aw" }, HOME, "linux").sessionGraphPath).toBe("/var/aw/.miner/graph.sqlite3");
  });

  it("prefers TITAN_CONSOLE_SESSION_GRAPH over ACTIVE_ROOT", () => {
    const env = { ACTIVE_ROOT: "/var/aw", TITAN_CONSOLE_SESSION_GRAPH: "/var/graphs/g.sqlite3" };
    expect(resolveConfig(env, HOME, "linux").sessionGraphPath).toBe("/var/graphs/g.sqlite3");
  });

  it("finds the session graph under XDG_DATA_HOME on linux", () => {
    expect(resolveConfig({ XDG_DATA_HOME: "/var/xdg" }, HOME, "linux").sessionGraphPath).toBe("/var/xdg/active-work/.miner/graph.sqlite3");
  });

  it("reads the agent-chat token from AGENT_CHAT_HOME unless a token path is given", () => {
    expect(resolveConfig({}, HOME).agentChatTokenPath).toBe(path.join(HOME, ".agent-chat", "ui.token"));
    expect(resolveConfig({ AGENT_CHAT_HOME: "/var/chat" }, HOME).agentChatTokenPath).toBe("/var/chat/ui.token");
    expect(resolveConfig({ TITAN_CONSOLE_AGENT_CHAT_TOKEN: "~/t" }, HOME).agentChatTokenPath).toBe(path.join(HOME, "t"));
  });

  it("reads agent-chat's events.db from AGENT_CHAT_HOME unless TITAN_CONSOLE_EVENTS_DB is given", () => {
    expect(resolveConfig({}, HOME).agentChatEventsDbPath).toBe(path.join(HOME, ".agent-chat", "events.db"));
    expect(resolveConfig({ AGENT_CHAT_HOME: "/var/chat" }, HOME).agentChatEventsDbPath).toBe("/var/chat/events.db");
    expect(resolveConfig({ TITAN_CONSOLE_EVENTS_DB: "~/e.db" }, HOME).agentChatEventsDbPath).toBe(path.join(HOME, "e.db"));
  });

  it("points node links at codewatch's default port unless TITAN_CONSOLE_CODEWATCH_URL is given", () => {
    expect(resolveConfig({}, HOME).codewatchUrl).toBe("http://127.0.0.1:7433");
    expect(resolveConfig({ TITAN_CONSOLE_CODEWATCH_URL: "https://code.example.test/cw/" }, HOME).codewatchUrl).toBe("https://code.example.test/cw/");
  });

  it("refuses a codewatch address that cannot prefix a node link", () => {
    expect(() => resolveConfig({ TITAN_CONSOLE_CODEWATCH_URL: "127.0.0.1:7433" }, HOME)).toThrow(/TITAN_CONSOLE_CODEWATCH_URL/);
    expect(() => resolveConfig({ TITAN_CONSOLE_CODEWATCH_URL: "http://127.0.0.1:7433/#/home" }, HOME)).toThrow(/no #fragment/);
  });

  it("parses seat prefixes and refuses a malformed pair", () => {
    expect(resolveConfig({}, HOME).seatPrefixes).toEqual([]);
    expect(resolveConfig({ TITAN_CONSOLE_SEATS: "alpha=al, beta=be" }, HOME).seatPrefixes).toEqual([
      { seat: "alpha", prefix: "al" },
      { seat: "beta", prefix: "be" },
    ]);
    expect(() => resolveConfig({ TITAN_CONSOLE_SEATS: "alpha" }, HOME)).toThrow(/seat=prefix/);
  });
});
