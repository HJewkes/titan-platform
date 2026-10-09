import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONSOLE_PORT, resolveConfig, type Machine } from "./config.js";

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

describe("console LAN config", () => {
  const LAN_IP = "192.0.2.10";
  const machine: Machine = { hostname: () => "Lan-Box", addresses: () => [LAN_IP, "2001:db8::a"] };
  const lan = (env: NodeJS.ProcessEnv) => resolveConfig(env, HOME, "linux", machine);

  it("stays on loopback alone when TITAN_CONSOLE_HOST is unset or empty", () => {
    expect(lan({}).lanHost).toBeNull();
    expect(lan({ TITAN_CONSOLE_HOST: "" }).lanHost).toBeNull();
  });

  it("takes an address on one of this machine's interfaces", () => {
    expect(lan({ TITAN_CONSOLE_HOST: LAN_IP }).lanHost).toBe(LAN_IP);
    expect(lan({ TITAN_CONSOLE_HOST: "2001:DB8::A" }).lanHost).toBe("2001:db8::a");
  });

  it.each([
    ["127.0.0.1", /loopback/],
    ["127.0.0.2", /loopback/],
    ["::1", /loopback/],
    ["::ffff:127.0.0.1", /loopback/],
    ["0.0.0.0", /wildcard/],
    ["::", /wildcard/],
    ["0:0:0:0:0:0:0:0", /wildcard/],
    ["localhost", /bare IP address/],
    ["lan-box", /bare IP address/],
    [`${LAN_IP}:7500`, /bare IP address/],
    ["[2001:db8::a]", /bare IP address/],
    [" 192.0.2.10", /bare IP address/],
    ["192.0.2.99", /this machine's interfaces/],
    [`::ffff:${LAN_IP}`, /this machine's interfaces/],
  ])("refuses TITAN_CONSOLE_HOST=%j", (host, reason) => {
    expect(() => lan({ TITAN_CONSOLE_HOST: host })).toThrow(reason);
  });

  it("defaults the LAN names to the hostname and its .local name", () => {
    expect(lan({}).lanNames).toEqual(["lan-box", "lan-box.local"]);
    expect(resolveConfig({}, HOME, "linux", { ...machine, hostname: () => "lan-box.local" }).lanNames).toEqual(["lan-box.local"]);
  });

  it("drops a default hostname that is not a DNS name instead of refusing to start", () => {
    expect(resolveConfig({}, HOME, "linux", { ...machine, hostname: () => "lan_box" }).lanNames).toEqual([]);
  });

  it("parses TITAN_CONSOLE_LAN_NAMES as a lowercased, deduplicated comma list", () => {
    expect(lan({ TITAN_CONSOLE_LAN_NAMES: " Basement , basement.local,basement " }).lanNames).toEqual(["basement", "basement.local"]);
  });

  it.each(["localhost", "box.localhost", "basement:7500", "192.0.2.10", "*.lan", "bad_name", "-lead", " , "])("refuses the LAN name %j", (names) => {
    expect(() => lan({ TITAN_CONSOLE_LAN_NAMES: names })).toThrow(/TITAN_CONSOLE_LAN_NAMES/);
  });

  // A localhost label anywhere can resolve to loopback, and a numeric last label is read as an IPv4 address by a WHATWG URL.
  it.each(["localhost.localdomain", "box.localhost.lan", "127.1", "box.0x7f", "lan.2130706433"])("refuses the loopback-shaped LAN name %j", (names) => {
    expect(() => lan({ TITAN_CONSOLE_LAN_NAMES: names })).toThrow(/TITAN_CONSOLE_LAN_NAMES/);
  });

  it("keeps a name whose labels only contain digits before the last", () => {
    expect(lan({ TITAN_CONSOLE_LAN_NAMES: "10.box,rack-7.lan" }).lanNames).toEqual(["10.box", "rack-7.lan"]);
  });

  it("keeps the LAN token in the state directory unless TITAN_CONSOLE_TOKEN is given", () => {
    expect(lan({}).lanTokenPath).toBe(path.join(HOME, ".local/state/titan-console", "lan.token"));
    expect(lan({ TITAN_CONSOLE_STATE: "/var/console" }).lanTokenPath).toBe("/var/console/lan.token");
    expect(lan({ TITAN_CONSOLE_TOKEN: "~/secrets/lan.token" }).lanTokenPath).toBe(path.join(HOME, "secrets", "lan.token"));
  });
});
