import { BlockList, isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { activeWorkGraphPath } from "@titan-design/app-paths";
import { isLoopbackHost } from "@titan-design/daemon";
import { expandHome } from "@titan-design/session-read";
import type { SeatPrefix } from "@titan-design/chat-protocol/agents";

/** Off 7400, which the active-work daemon and `titan-miner serve` both default to. */
export const DEFAULT_CONSOLE_PORT = 7500;
const ACTIVE_WORK_PORT = 7400;
const AGENT_CHAT_PORT = 7600;
/** Codewatch's `CODE_REPORT_PORT`. */
export const DEFAULT_CODEWATCH_URL = "http://127.0.0.1:7433";

export interface ConsoleConfig {
  /** 0 binds an ephemeral port. */
  port: number;
  /** Holds the console daemon's pid file. */
  stateDir: string;
  /** Loopback ports of the two upstream daemons; the console never starts either. */
  activeWorkPort: number;
  agentChatPort: number;
  /** agent-chat's `ui.token`; the broker's `/api/*` reads need it in a header. */
  agentChatTokenPath: string;
  /** agent-chat's event log, which agents.messages pages through read-only. */
  agentChatEventsDbPath: string;
  /** Which seat owns the agents named `<prefix>-...`. */
  seatPrefixes: SeatPrefix[];
  sessionGraphPath: string;
  /** Where a touched file's code-graph node link points; the console never starts codewatch. */
  codewatchUrl: string;
  /** The LAN address behind auth; null keeps the console on loopback alone. */
  lanHost: string | null;
  /** Names the LAN listener answers to; the first one goes into a login link. */
  lanNames: string[];
  /** The LAN secret; `login-link` and `token rotate` use it even when `lanHost` is null. */
  lanTokenPath: string;
  /** `TITAN_CONSOLE_OWNER_WRITES=1` lets owner-write commands run on the LAN; off until the LAN carries TLS. */
  ownerWrites: boolean;
}

/** What `resolveConfig` asks of the machine it runs on; a seam for tests. */
export interface Machine {
  hostname(): string;
  /** Every address on a non-internal interface, so loopback is never among them. */
  addresses(): string[];
}

const hostMachine: Machine = {
  hostname: () => os.hostname(),
  addresses: () =>
    Object.values(os.networkInterfaces())
      .flatMap((list) => list ?? [])
      .filter((entry) => !entry.internal)
      .map((entry) => entry.address),
};

/** `TITAN_CONSOLE_*` overrides win, then the defaults; a port shared with an upstream is refused. */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  machine: Machine = hostMachine,
): ConsoleConfig {
  const stateDir = expandHome(env.TITAN_CONSOLE_STATE ?? "~/.local/state/titan-console", home);
  const config: ConsoleConfig = {
    port: portFrom(env, "TITAN_CONSOLE_PORT", DEFAULT_CONSOLE_PORT),
    stateDir,
    activeWorkPort: portFrom(env, "TITAN_CONSOLE_ACTIVE_WORK_PORT", ACTIVE_WORK_PORT),
    agentChatPort: portFrom(env, "TITAN_CONSOLE_AGENT_CHAT_PORT", AGENT_CHAT_PORT),
    agentChatTokenPath: expandHome(env.TITAN_CONSOLE_AGENT_CHAT_TOKEN ?? path.join(env.AGENT_CHAT_HOME ?? "~/.agent-chat", "ui.token"), home),
    agentChatEventsDbPath: expandHome(env.TITAN_CONSOLE_EVENTS_DB ?? path.join(env.AGENT_CHAT_HOME ?? "~/.agent-chat", "events.db"), home),
    seatPrefixes: seatPrefixesFrom(env.TITAN_CONSOLE_SEATS),
    sessionGraphPath: expandHome(env.TITAN_CONSOLE_SESSION_GRAPH ?? activeWorkGraphPath({ env, home, platform }), home),
    codewatchUrl: urlFrom(env, "TITAN_CONSOLE_CODEWATCH_URL", DEFAULT_CODEWATCH_URL),
    lanHost: lanHostFrom(env.TITAN_CONSOLE_HOST, machine),
    lanNames: lanNamesFrom(env.TITAN_CONSOLE_LAN_NAMES, machine),
    lanTokenPath: expandHome(env.TITAN_CONSOLE_TOKEN || path.join(stateDir, "lan.token"), home),
    ownerWrites: ownerWritesFrom(env.TITAN_CONSOLE_OWNER_WRITES),
  };
  if (config.port === config.activeWorkPort || config.port === config.agentChatPort) {
    throw new Error(`TITAN_CONSOLE_PORT ${config.port} belongs to an upstream daemon; the console needs a port of its own`);
  }
  return config;
}

function portFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  // A typo that silently bound another port would be worse than a refusal.
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} must be a port number, got "${raw}"`);
  return port;
}

/** The address is used as a link prefix, so a value with a hash would put `#/node/` inside the existing fragment. */
function urlFrom(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const url = URL.canParse(raw) ? new URL(raw) : null;
  if (!url || !["http:", "https:"].includes(url.protocol) || url.hash !== "") throw new Error(`${name} must be an http(s) address with no #fragment, got "${raw}"`);
  return raw;
}

/** Only `1` turns owner writes on; any other value is refused rather than read as off, so a typo is never silent. */
function ownerWritesFrom(raw: string | undefined): boolean {
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`TITAN_CONSOLE_OWNER_WRITES must be 1 or 0, got "${raw}"`);
}

const WILDCARDS = new BlockList();
WILDCARDS.addSubnet("0.0.0.0", 8, "ipv4");
WILDCARDS.addAddress("::", "ipv6");

/**
 * One concrete address of this machine, never loopback or a wildcard: a wildcard would also
 * expose every bridge and VPN interface. A name is refused because it could resolve to either.
 */
function lanHostFrom(raw: string | undefined, machine: Machine): string | null {
  if (raw === undefined || raw === "") return null;
  const refuse = (reason: string): never => {
    throw new Error(`TITAN_CONSOLE_HOST ${reason}, got "${raw}"`);
  };
  const family = isIP(raw);
  if (family === 0) refuse("must be a bare IP address");
  if (isLoopbackHost(raw)) refuse("must not be loopback; the console always listens on 127.0.0.1");
  if (WILDCARDS.check(raw, family === 4 ? "ipv4" : "ipv6")) refuse("must not be a wildcard; name one interface address");
  const host = raw.toLowerCase();
  if (!machine.addresses().some((address) => address.toLowerCase() === host)) refuse("must be an address on one of this machine's interfaces");
  return host;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The WHATWG URL parser reads a host whose last label is a number as IPv4, so `127.1` is loopback. */
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;

/** Hostnames only: no port, no IP (the bound address is allowed already) and nothing loopback. */
function isLanName(name: string): boolean {
  if (name.length > 253 || isIP(name) !== 0 || isLoopbackHost(name)) return false;
  const labels = name.split(".");
  if (NUMERIC_LABEL.test(labels.at(-1) ?? "") || labels.includes("localhost")) return false;
  return labels.every((label) => DNS_LABEL.test(label));
}

/** `TITAN_CONSOLE_LAN_NAMES` is a comma list; the default is this machine's hostname and its `.local` mDNS name. */
function lanNamesFrom(raw: string | undefined, machine: Machine): string[] {
  if (raw === undefined || raw.trim() === "") {
    const hostname = machine.hostname().toLowerCase();
    const defaults = hostname.endsWith(".local") ? [hostname] : [hostname, `${hostname}.local`];
    return defaults.filter(isLanName);
  }
  const names = raw.split(",").map((name) => name.trim().toLowerCase()).filter((name) => name !== "");
  const bad = names.find((name) => !isLanName(name));
  if (bad !== undefined || names.length === 0) {
    throw new Error(`TITAN_CONSOLE_LAN_NAMES must be a comma list of DNS names with no port, IP or loopback name, got "${bad ?? raw}"`);
  }
  return [...new Set(names)];
}

/** `TITAN_CONSOLE_SEATS` is `seat=prefix` pairs separated by commas, e.g. `titan-coord=tpc`. */
function seatPrefixesFrom(raw: string | undefined): SeatPrefix[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((pair) => {
    const [seat, prefix, extra] = pair.split("=").map((part) => part.trim());
    if (!seat || !prefix || extra !== undefined) throw new Error(`TITAN_CONSOLE_SEATS entries must be seat=prefix, got "${pair}"`);
    return { seat, prefix };
  });
}

