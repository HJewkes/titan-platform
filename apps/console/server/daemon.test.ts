import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type * as NetModule from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as daemonPackage from "@titan-design/daemon";
import { SESSION_COOKIE, TlsFileError, TokenFileError, daemonPaths, readPidFile, silentLogger, type DaemonHandle, type Logger } from "@titan-design/daemon";
import { createRpcClient, liveSource, snapshotKey } from "@titan-design/rpc-client";
import { openSessionGraph } from "@titan-design/session-graph";
import type { ConsoleCommands } from "./commands.js";
import type { ConsoleConfig } from "./config.js";
import { createLoginLink, rotateLanToken, startConsoleDaemon } from "./daemon.js";
import { fixtureAnswer } from "./fixtures.js";
import { createConsoleRegistry, recordFirstPaint } from "./registry.js";
import { closedPort, send, sessionCookie, startFakeBroker, startFakeDaemon, writeSelfSignedCert, type FakeDaemon, type Reply, type SelfSignedPair } from "./test-support.js";
import { createSources } from "./upstreams.js";

// The one seam for the LAN suite: the daemon refuses all of 127/8 as a remote host through a
// node:net BlockList, so 127.0.0.2, the stand-in LAN address, is let past that check alone.
// Every other address still meets the real rule.
const LAN = vi.hoisted(() => "127.0.0.2");
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof NetModule>();
  class StandInBlockList extends actual.BlockList {
    override check(address: string | NetModule.SocketAddress, type?: NetModule.IPVersion): boolean {
      return address === LAN ? false : super.check(address as string, type);
    }
  }
  return { ...actual, default: { ...actual, BlockList: StandInBlockList }, BlockList: StandInBlockList };
});

// Spied, not replaced: the suite still starts the real daemon, and reads what the console asked of it.
vi.mock("@titan-design/daemon", async (importOriginal) => {
  const actual = await importOriginal<typeof daemonPackage>();
  return { ...actual, startDaemon: vi.fn(actual.startDaemon) };
});

let dir: string;
let activeWork: FakeDaemon;
let config: ConsoleConfig;
let handle: DaemonHandle | undefined;
let pair: SelfSignedPair;

/** HTTPS to the LAN listener, trusting the test certificate for the LAN name. */
const sendLan = (port: number, method: string, route: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> =>
  send(LAN, port, method, route, headers, body, { ca: pair.cert, servername: "lan-box" });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-daemon-"));
  pair = writeSelfSignedCert(dir, ["lan-box", LAN]);
  activeWork = await startFakeDaemon({ ok: true, version: "9.9.9", index: {} }, fixtureAnswer);
  config = {
    port: 0,
    stateDir: path.join(dir, "state"),
    activeWorkPort: activeWork.port,
    agentChatPort: await closedPort(),
    agentChatTokenPath: path.join(dir, "ui.token"),
    agentChatEventsDbPath: path.join(dir, "events.db"),
    seatPrefixes: [],
    sessionGraphPath: path.join(dir, "graph.sqlite3"),
    codewatchUrl: "http://codewatch.test:7433",
    lanHost: null,
    lanNames: [],
    lanTls: { certFile: pair.certFile, keyFile: pair.keyFile },
    lanTokenPath: path.join(dir, "state", "lan.token"),
    ownerWrites: false,
    inboxDir: path.join(dir, "state", "inbox", "deposits"),
  };
  await writeFile(config.sessionGraphPath, "synthetic");
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await activeWork.close();
  await rm(dir, { recursive: true, force: true });
});

const origin = (): string => `http://127.0.0.1:${handle!.port}`;

const SESSION = "0a1b2c3d-0000-4000-8000-0000000000aa";

/** An indexed session whose transcript edits each path once, beside a clone of `widget` at `<dir>/checkout`. */
async function seedSessionTouching(files: readonly string[]): Promise<readonly string[]> {
  await mkdir(path.join(dir, "checkout", ".git"), { recursive: true });
  await writeFile(path.join(dir, "checkout", ".git", "config"), '[remote "origin"]\n\turl = https://example.com/acme/widget.git\n');
  const transcript = path.join(dir, `${SESSION}.jsonl`);
  const calls = files.map((file, i) => ({ type: "tool_use", id: `edit-${i}`, name: "Edit", input: { file_path: file } }));
  const reply = { type: "assistant", uuid: "a1", sessionId: SESSION, timestamp: "2026-09-01T10:00:05Z", message: { role: "assistant", id: "m1", model: "claude-opus-5", content: calls } };
  await writeFile(transcript, `${JSON.stringify(reply)}\n`);
  await rm(config.sessionGraphPath);
  const graph = openSessionGraph(config.sessionGraphPath);
  try {
    const { sourceId } = graph.transcripts.ensure(transcript);
    graph.db.prepare("INSERT INTO session (session_id, transcript_id, started_at, turn_count) VALUES (?, ?, '2026-09-01T10:00:00Z', 1)").run(SESSION, sourceId);
  } finally {
    graph.db.close();
  }
  return files;
}

describe("the console daemon", () => {
  it("answers upstreams.health through a typed client with all three upstreams", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    const client = createRpcClient<ConsoleCommands>(liveSource({ origin: origin() }));
    const { upstreams, checkedAt } = await client.call("upstreams.health");
    expect(Number.isNaN(Date.parse(checkedAt))).toBe(false);
    expect(upstreams.map(({ id, reachable }) => ({ id, reachable }))).toEqual([
      { id: "work", reachable: true },
      { id: "agents", reachable: false },
      { id: "sessions", reachable: true },
    ]);
  });

  it("answers work.portfolio from the active-work daemon it fronts", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    const client = createRpcClient<ConsoleCommands>(liveSource({ origin: origin() }));
    const { initiatives } = await client.call("work.portfolio");
    expect(initiatives).toHaveLength(5);
    const detail = await client.call("work.initiative", { slug: "lantern-docs" });
    expect(detail.tasks.map((task) => task.id)).toEqual(["LD-3"]);
  });

  it("lists the upstream targets on /health without probing them", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    const health = (await (await fetch(`${origin()}/health`)).json()) as { ok: boolean; upstreams: Array<{ id: string; target: string }> };
    expect(health.ok).toBe(true);
    expect(health.upstreams.map((u) => u.id)).toEqual(["work", "agents", "sessions"]);
    expect(health.upstreams[0]?.target).toBe(`http://127.0.0.1:${activeWork.port}`);
  });

  it("serves the built app shell at / and for a client route", async () => {
    const page = path.join(dir, "index.html");
    await writeFile(page, "<!doctype html><title>console shell</title>");
    handle = await startConsoleDaemon({ config, staticRoot: page, logger: silentLogger });
    for (const route of ["/", "/sessions"]) {
      const res = await fetch(`${origin()}${route}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("console shell");
    }
  });

  it("answers agents.messages and agents.queue from a fake broker over /rpc", async () => {
    const queue = [{ msgId: "q1", kind: "question", from: "coord", text: "Ship?", at: 1_000, meta: {} }];
    const items = [{ msgId: "m1", kind: "message", from: "coord", text: "go", at: 2_000, meta: { target: "impl" } }];
    const broker = await startFakeBroker({ token: "synthetic-token", sessions: [], items, queue });
    await writeFile(config.agentChatTokenPath, "synthetic-token");
    await chmod(config.agentChatTokenPath, 0o600);
    handle = await startConsoleDaemon({ config: { ...config, agentChatPort: broker.port }, logger: silentLogger });
    const client = createRpcClient<ConsoleCommands>(liveSource({ origin: origin() }));
    const messages = await client.call("agents.messages", { agent: "impl", limit: 50 });
    const open = await client.call("agents.queue", {});
    await broker.close();
    expect(messages).toMatchObject({ source: "history", partial: true, messages: [{ msgId: "m1", from: "coord", to: "impl" }] });
    expect(open.items).toMatchObject([{ msgId: "q1", asker: "coord" }]);
    expect(broker.requests.every((request) => request.startsWith("GET "))).toBe(true);
  });

  it("links a session's touched files to codewatch node pages over /rpc", async () => {
    const touched = await seedSessionTouching([path.join(dir, "checkout", ".worktrees", "gone", "src", "a.ts"), path.join(dir, "notes.md")]);
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    const client = createRpcClient<ConsoleCommands>(liveSource({ origin: origin() }));
    const result = await client.call("sessions.timeline", { sessionId: SESSION });
    expect(result).toMatchObject({ status: "ok", source: "graph" });
    expect(result.status === "ok" ? result.touchedFiles : []).toEqual([
      { touchPath: touched[0], ref: "file:widget/src/a.ts", repo: "widget", path: "src/a.ts", nodeId: "src/a.ts", href: "http://codewatch.test:7433#/node/src%2Fa.ts" },
      { touchPath: touched[1], ref: `file:${touched[1]}`, repo: null, path: touched[1], nodeId: null, href: null },
    ]);
  });

  it("refuses a second console over the same state directory", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    await expect(startConsoleDaemon({ config, logger: silentLogger })).rejects.toThrow(/already running/);
  });
});

describe("the console's remote listener options", () => {
  const startDaemonSpy = vi.mocked(daemonPackage.startDaemon);
  beforeEach(() => {
    startDaemonSpy.mockClear();
  });

  it("asks for no remote listener and no unauthenticated bind when TITAN_CONSOLE_HOST is unset", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });

    const [options] = startDaemonSpy.mock.calls[0]!;
    expect(options).not.toHaveProperty("remote");
    expect(options).not.toHaveProperty("host");
    expect(options).not.toHaveProperty("allowUnauthenticatedNonLoopback");
  });

  it("refuses to start in LAN mode without TLS, before the token file or any bind", async () => {
    await expect(startConsoleDaemon({ config: { ...config, lanHost: "192.0.2.1", lanTls: null }, logger: silentLogger })).rejects.toThrow(/serves HTTPS only/);
    expect(startDaemonSpy).not.toHaveBeenCalled();
    expect(await readPidFile(daemonPaths(config.stateDir))).toBeNull();
  });

  it("refuses to start in LAN mode on a group-readable token file, and binds nothing", async () => {
    await mkdir(config.stateDir, { recursive: true });
    await writeFile(config.lanTokenPath, "A".repeat(43));
    await chmod(config.lanTokenPath, 0o640);

    await expect(startConsoleDaemon({ config: { ...config, lanHost: "192.0.2.1" }, logger: silentLogger })).rejects.toBeInstanceOf(TokenFileError);
    expect(startDaemonSpy).not.toHaveBeenCalled();
    expect(await readPidFile(daemonPaths(config.stateDir))).toBeNull();
  });
});

describe("login-link and token rotate", () => {
  const lanConfig = (): ConsoleConfig => ({ ...config, port: 7500, lanNames: ["lan-box", "lan-box.local"] });

  it("prints an https link to the first LAN name with a fresh code, creating the token file at 0600", () => {
    const url = new URL(createLoginLink(lanConfig()));

    expect(url.origin).toBe("https://lan-box:7500");
    expect(url.pathname).toBe("/auth/login");
    expect(/^v1\.\d+\.[\w-]{22}\.[\w-]{43}$/.test(url.searchParams.get("code") ?? "")).toBe(true);
    expect(statSync(config.lanTokenPath).mode & 0o777).toBe(0o600);
  });

  it("mints a different code each time", () => {
    expect(createLoginLink(lanConfig()) === createLoginLink(lanConfig())).toBe(false);
  });

  it("falls back to the bound address when there is no LAN name, and refuses when there is neither", () => {
    expect(new URL(createLoginLink({ ...lanConfig(), lanNames: [], lanHost: "192.0.2.1" })).origin).toBe("https://192.0.2.1:7500");
    expect(new URL(createLoginLink({ ...lanConfig(), lanNames: [], lanHost: "2001:db8::a" })).origin).toBe("https://[2001:db8::a]:7500");
    expect(() => createLoginLink({ ...lanConfig(), lanNames: [] })).toThrow(/TITAN_CONSOLE_LAN_NAMES/);
  });

  it("refuses an ephemeral port, which no link could name", () => {
    expect(() => createLoginLink({ ...lanConfig(), port: 0 })).toThrow(/TITAN_CONSOLE_PORT/);
  });

  it("rotates the token file in place at 0600", () => {
    createLoginLink(lanConfig());
    const before = statSync(config.lanTokenPath).ino;

    rotateLanToken(lanConfig());

    expect(statSync(config.lanTokenPath).ino).not.toBe(before);
    expect(statSync(config.lanTokenPath).mode & 0o777).toBe(0o600);
  });
});

// Linux routes all of 127/8 to lo; macOS answers only 127.0.0.1 unless an alias is added.
describe.skipIf(process.platform !== "linux")("the console in LAN mode (127.0.0.2 stands in for the LAN)", () => {
  const NAME = "lan-box";
  const json = { "content-type": "application/json" };
  let port: number;
  let page: string;

  beforeEach(async () => {
    page = path.join(dir, "index.html");
    await writeFile(page, "<!doctype html><title>console shell</title>");
  });

  async function startLan(overrides: Partial<ConsoleConfig> = {}): Promise<ConsoleConfig> {
    const lan = { ...config, lanHost: LAN, lanNames: [NAME], ...overrides };
    handle = await startConsoleDaemon({ config: lan, staticRoot: page, logger: silentLogger });
    port = handle.port;
    return { ...lan, port };
  }

  /** What a browser that followed the link sends: the LAN name and the bound port. */
  const lanHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({ host: `${NAME}:${port}`, ...extra });
  const sameOrigin = (): Record<string, string> => ({ origin: `https://${NAME}:${port}` });
  const lan = (method: string, route: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> =>
    sendLan(port, method, route, lanHeaders(headers), body);
  const rpc = (command: string, headers: Record<string, string> = {}, args: unknown = {}): Promise<Reply> =>
    lan("POST", `/rpc/${command}`, { ...json, ...sameOrigin(), ...headers }, JSON.stringify(args));

  /** The page's own script would read the code from its query and post it back. */
  function codeOf(link: string): string {
    return new URL(link).searchParams.get("code") ?? "";
  }

  async function postCode(code: string, headers: Record<string, string> = sameOrigin()): Promise<Reply> {
    return lan("POST", "/auth/login", { ...json, ...headers }, JSON.stringify({ code }));
  }

  async function signIn(lanConfig: ConsoleConfig): Promise<Record<string, string>> {
    const reply = await postCode(codeOf(createLoginLink(lanConfig)));
    expect(reply.status).toBe(200);
    return { cookie: sessionCookie(reply)!.split(";")[0]! };
  }

  it("passes remote { host, tokenFile, allowedHosts, tls } and never the unauthenticated opt-in", async () => {
    const startDaemonSpy = vi.mocked(daemonPackage.startDaemon);
    startDaemonSpy.mockClear();

    await startLan();

    const [options] = startDaemonSpy.mock.calls[0]!;
    expect(options.remote).toEqual({ host: LAN, tokenFile: config.lanTokenPath, allowedHosts: [NAME], tls: { certFile: pair.certFile, keyFile: pair.keyFile } });
    expect(options).not.toHaveProperty("host");
    expect(options).not.toHaveProperty("allowUnauthenticatedNonLoopback");
  });

  it("gives a plain-HTTP request to the LAN address no reply at all", async () => {
    await startLan();

    await expect(send(LAN, port, "GET", "/", lanHeaders({ accept: "text/html" }))).rejects.toThrow(/socket hang up|ECONNRESET/);
  });

  it("fails start on a missing certificate, binding nothing and writing no pid file", async () => {
    const missing = { certFile: path.join(dir, "absent.crt"), keyFile: pair.keyFile };

    await expect(startLan({ lanTls: missing })).rejects.toBeInstanceOf(TlsFileError);
    expect(await readPidFile(daemonPaths(config.stateDir))).toBeNull();
  });

  it("fails start when the certificate does not cover a LAN name, as the hostname defaults would not", async () => {
    await expect(startLan({ lanNames: [NAME, "lan-box.local"] })).rejects.toThrow(/does not cover the name "lan-box.local"/);
  });

  it("answers 401 to an unauthenticated LAN /rpc/upstreams.health, the page and /health", async () => {
    await startLan();

    const health = await rpc("upstreams.health");
    const shell = await lan("GET", "/", { accept: "text/html" });
    const daemonHealth = await lan("GET", "/health");

    expect([health.status, shell.status, daemonHealth.status]).toEqual([401, 401, 401]);
    expect(shell.body).not.toContain("console shell");
  });

  it("answers 401 to an unauthenticated LAN /events, which carries the upstream relay", async () => {
    await startLan();

    expect((await lan("GET", "/events", { accept: "text/event-stream" })).status).toBe(401);
  });

  it("signs in with login-link's code in two steps: an inert GET, then a JSON POST that sets the cookie", async () => {
    const lanConfig = await startLan();
    const link = new URL(createLoginLink(lanConfig));
    const code = codeOf(link.href);

    const landing = await lan("GET", `${link.pathname}${link.search}`, { accept: "text/html" });
    expect(landing.status).toBe(200);
    expect(sessionCookie(landing)).toBeUndefined();
    expect(landing.headers["cache-control"]).toBe("no-store");
    expect(landing.headers["referrer-policy"]).toBe("no-referrer");
    expect(landing.body.includes(code)).toBe(false);

    const login = await postCode(code);
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login) ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/SameSite=Strict/i);

    const credential = { cookie: cookie.split(";")[0]! };
    const health = await rpc("upstreams.health", credential);
    const shell = await lan("GET", "/", { accept: "text/html", ...credential });
    expect([health.status, shell.status]).toEqual([200, 200]);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true });
    expect(shell.body).toContain("console shell");
  });

  it("spends a code once", async () => {
    const lanConfig = await startLan();
    const code = codeOf(createLoginLink(lanConfig));

    const first = await postCode(code);
    const replay = await postCode(code);

    expect([first.status, replay.status]).toEqual([200, 401]);
    expect(sessionCookie(replay)).toBeUndefined();
  });

  it("answers 403 to Host: evil.example on the login page, the login POST and /rpc, and leaves the code unspent", async () => {
    const lanConfig = await startLan();
    const code = codeOf(createLoginLink(lanConfig));
    const evil = { host: `evil.example:${port}` };

    const landing = await sendLan(port, "GET", `/auth/login?code=${encodeURIComponent(code)}`, { ...evil, accept: "text/html" });
    const login = await sendLan(port, "POST", "/auth/login", { ...evil, ...json, origin: `http://evil.example:${port}` }, JSON.stringify({ code }));
    const health = await sendLan(port, "POST", "/rpc/upstreams.health", { ...evil, ...json, origin: `http://evil.example:${port}` }, "{}");
    const portless = await sendLan(port, "GET", "/health", { host: "evil.example" });

    expect([landing.status, login.status, health.status, portless.status]).toEqual([403, 403, 403, 403]);
    expect((await postCode(code)).status).toBe(200);
  });

  it("refuses a login POST from a cross-site Origin", async () => {
    const lanConfig = await startLan();

    const login = await postCode(codeOf(createLoginLink(lanConfig)), { origin: "http://evil.example" });

    expect(login.status).toBe(403);
  });

  it("answers loopback with no credentials while LAN mode is on, and keeps LAN names off it", async () => {
    await startLan();

    const health = await send("127.0.0.1", port, "POST", "/rpc/upstreams.health", { ...json, "x-titan-client": "test" }, "{}");
    const shell = await send("127.0.0.1", port, "GET", "/", { accept: "text/html" });
    const lanName = await send("127.0.0.1", port, "GET", "/health", { host: `${NAME}:${port}` });

    expect([health.status, shell.status, lanName.status]).toEqual([200, 200, 403]);
  });

  it("logs out with a JSON POST, which clears the cookie, and refuses a form-encoded or cross-site one", async () => {
    const lanConfig = await startLan();
    const credential = await signIn(lanConfig);

    const form = await lan("POST", "/auth/logout", { ...credential, ...sameOrigin(), "content-type": "application/x-www-form-urlencoded" }, "");
    const crossSite = await lan("POST", "/auth/logout", { ...credential, ...json, origin: "http://evil.example" }, "{}");
    const anonymous = await lan("POST", "/auth/logout", { ...json, ...sameOrigin() }, "{}");
    const logout = await lan("POST", "/auth/logout", { ...credential, ...json, ...sameOrigin() }, "{}");

    expect([form.status, crossSite.status, anonymous.status, logout.status]).toEqual([415, 403, 401, 200]);
    expect(JSON.parse(logout.body)).toEqual({ ok: true });
    expect(sessionCookie(logout)).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`, "i"));
  });

  it("ends every session and voids every outstanding link on token rotate, with no restart", async () => {
    const lanConfig = await startLan();
    const credential = await signIn(lanConfig);
    const pending = codeOf(createLoginLink(lanConfig));
    expect((await rpc("upstreams.health", credential)).status).toBe(200);

    rotateLanToken(lanConfig);

    expect((await rpc("upstreams.health", credential)).status).toBe(401);
    expect((await postCode(pending)).status).toBe(401);
    expect((await rpc("upstreams.health", await signIn(lanConfig))).status).toBe(200);
  });

  it("returns no rpc result that contains the agent-chat ui.token value", async () => {
    const uiToken = "synthetic-ui-token-4f1c9a";
    const items = [{ msgId: "m1", kind: "message", from: "coord", text: "go", at: 2_000, meta: { target: "impl" } }];
    const broker = await startFakeBroker({ token: uiToken, sessions: [], items, queue: [] });
    await writeFile(config.agentChatTokenPath, uiToken);
    await chmod(config.agentChatTokenPath, 0o600);
    try {
      const lanConfig = await startLan({ agentChatPort: broker.port });
      const credential = await signIn(lanConfig);
      const calls: Array<[string, unknown]> = [
        ["upstreams.health", {}],
        ["agents.roster", {}],
        ["agents.graph", {}],
        ["agents.messages", { agent: "impl", limit: 50 }],
        ["agents.queue", {}],
        ["work.portfolio", {}],
      ];
      const replies = await Promise.all(calls.map(([command, args]) => rpc(command, credential, args)));
      const daemonHealth = await lan("GET", "/health", credential);

      expect(replies.map((reply) => reply.status)).toEqual(calls.map(() => 200));
      expect(broker.requests.length).toBeGreaterThan(0);
      expect([...replies, daemonHealth].filter((reply) => reply.body.includes(uiToken))).toHaveLength(0);
    } finally {
      await broker.close();
    }
  });
});

/** Runs the real `titan-console token rotate` bin, so two of them race as two processes would. */
function rotateInChild(tokenPath: string): Promise<void> {
  const consoleDir = path.join(import.meta.dirname, "..");
  const env = { ...process.env, TITAN_CONSOLE_TOKEN: tokenPath, TITAN_CONSOLE_STATE: path.dirname(tokenPath), TITAN_CONSOLE_LAN_NAMES: "lan-box" };
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", "server/cli.ts", "token", "rotate"], { cwd: consoleDir, env }, (err) => (err ? reject(err) : resolve()));
  });
}

/** A broker that fails every read, putting the token it was sent into each failure. */
async function startEchoingBroker(): Promise<FakeDaemon> {
  const server = createServer((req, res) => {
    const sent = String(req.headers["x-agent-chat-token"] ?? "");
    const route = (req.url ?? "").split("?")[0];
    if (route === "/api/history") {
      res.writeHead(302, { location: `http://127.0.0.1:1/steal?token=${sent}` }).end();
    } else if (route === "/api/queue") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items: sent }));
    } else {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: `bad token ${sent}` }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = (): Promise<void> => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  };
  return { port: (server.address() as NetModule.AddressInfo).port, close };
}

describe.skipIf(process.platform !== "linux")("the console's LAN listener under hostile hosts, rotation and broker failures", () => {
  const NAME = "lan-box";
  const json = { "content-type": "application/json" };
  let port: number;
  let lanConfig: ConsoleConfig;

  async function startLan(logger: Logger = silentLogger, overrides: Partial<ConsoleConfig> = {}): Promise<void> {
    const page = path.join(dir, "index.html");
    await writeFile(page, "<!doctype html><title>console shell</title>");
    const lan = { ...config, lanHost: LAN, lanNames: [NAME], ...overrides };
    handle = await startConsoleDaemon({ config: lan, staticRoot: page, logger });
    port = handle.port;
    lanConfig = { ...lan, port };
  }

  const sameOrigin = (): Record<string, string> => ({ host: `${NAME}:${port}`, origin: `https://${NAME}:${port}` });
  const health = (headers: Record<string, string>): Promise<Reply> =>
    sendLan(port, "POST", "/rpc/upstreams.health", { ...json, ...sameOrigin(), ...headers }, "{}");
  const bearer = (): Record<string, string> => ({ authorization: `Bearer ${readFileSync(config.lanTokenPath, "utf8").trim()}` });

  async function signIn(): Promise<Record<string, string>> {
    const code = new URL(createLoginLink(lanConfig)).searchParams.get("code") ?? "";
    const reply = await sendLan(port, "POST", "/auth/login", { ...json, ...sameOrigin() }, JSON.stringify({ code }));
    expect(reply.status).toBe(200);
    return { cookie: sessionCookie(reply)!.split(";")[0]! };
  }

  it("answers 403 to a signed-in GET / with a foreign Host or the LAN name without its port", async () => {
    await startLan();
    const credential = await signIn();

    const own = await sendLan(port, "GET", "/", { host: `${NAME}:${port}`, accept: "text/html", ...credential });
    const foreign = await sendLan(port, "GET", "/", { host: `evil.example:${port}`, accept: "text/html", ...credential });
    const portless = await sendLan(port, "GET", "/", { host: NAME, accept: "text/html", ...credential });

    expect([own.status, foreign.status, portless.status]).toEqual([200, 403, 403]);
    expect([foreign.body, portless.body].some((body) => body.includes("console shell"))).toBe(false);
  });

  it("answers 401 to the old bearer after token rotate, and 200 to the new one", async () => {
    await startLan();
    const old = bearer();
    expect((await health(old)).status).toBe(200);

    rotateLanToken(lanConfig);

    expect((await health(old)).status).toBe(401);
    expect((await health(bearer())).status).toBe(200);
  });

  it("leaves one 0600 token file and no live old credential after two concurrent rotates", async () => {
    await startLan();
    const oldCookie = await signIn();
    const oldBearer = bearer();

    await Promise.all([rotateInChild(config.lanTokenPath), rotateInChild(config.lanTokenPath)]);

    expect(readdirSync(path.dirname(config.lanTokenPath)).filter((name) => name.includes("lan.token"))).toEqual(["lan.token"]);
    expect(statSync(config.lanTokenPath).mode & 0o777).toBe(0o600);
    expect([(await health(oldCookie)).status, (await health(oldBearer)).status]).toEqual([401, 401]);
    expect((await health(bearer())).status).toBe(200);
  }, 30_000);

  it("keeps the ui.token out of every envelope and log line when the broker fails", async () => {
    const uiToken = "synthetic-ui-token-9b2e7d";
    const broker = await startEchoingBroker();
    await writeFile(config.agentChatTokenPath, uiToken);
    await chmod(config.agentChatTokenPath, 0o600);
    const lines: string[] = [];
    const record = (fields: Record<string, unknown>, message: string): void => {
      lines.push(`${message} ${JSON.stringify(fields, (_key, value: unknown) => (value instanceof Error ? { message: value.message, stack: value.stack, cause: String(value.cause) } : value))}`);
    };
    try {
      await startLan({ info: record, warn: record, error: record }, { agentChatPort: broker.port });
      const credential = await signIn();
      const calls: Array<[string, unknown]> = [
        ["agents.roster", {}],
        ["agents.graph", {}],
        ["agents.messages", { agent: "impl", limit: 50 }],
        ["agents.queue", {}],
      ];

      const replies = await Promise.all(calls.map(([command, args]) => sendLan(port, "POST", `/rpc/${command}`, { ...json, ...sameOrigin(), ...credential }, JSON.stringify(args))));

      expect(replies.map((reply) => (JSON.parse(reply.body) as { ok: boolean }).ok)).toEqual(calls.map(() => false));
      expect([...replies.map((reply) => reply.body), ...lines].filter((text) => text.includes(uiToken))).toEqual([]);
    } finally {
      await broker.close();
    }
  });
});

describe("the first-paint snapshot", () => {
  it("records upstreams.health so an exported page needs no daemon", async () => {
    const snapshot = await recordFirstPaint(createConsoleRegistry(createSources(config)));
    expect(snapshot.calls[snapshotKey("upstreams.health", {})]).toMatchObject({ ok: true });
  });
});
