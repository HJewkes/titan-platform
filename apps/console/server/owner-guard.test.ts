import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as NetModule from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as daemonPackage from "@titan-design/daemon";
import { silentLogger, type DaemonHandle, type RequestAuth } from "@titan-design/daemon";
import { EXIT, invokeCommand } from "@titan-design/registry";
import type { ConsoleConfig } from "./config.js";
import { createLoginLink, startConsoleDaemon } from "./daemon.js";
import { fixtureAnswer } from "./fixtures.js";
import {
  REFUSALS,
  depositCommand,
  ownerWriteCommand,
  readCommand,
  type ConsoleContext,
  type ConsoleSurface,
} from "./owner-guard.js";
import { createConsoleRegistry } from "./registry.js";
import { closedPort, send, sessionCookie, startFakeDaemon, type FakeDaemon, type Reply } from "./test-support.js";
import { createSources } from "./upstreams.js";

// The LAN seam daemon.test.ts uses: 127.0.0.2 alone is let past the daemon's refusal of 127/8
// as a remote host, so it stands in for the LAN address.
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

vi.mock("@titan-design/daemon", async (importOriginal) => {
  const actual = await importOriginal<typeof daemonPackage>();
  return { ...actual, startDaemon: vi.fn(actual.startDaemon) };
});

const OWNER_WRITE = "test.answer";
const DEPOSIT = "test.deposit";
let ran: Array<{ command: string; issuedAt?: number }>;

const stubOwnerWrite = ownerWriteCommand({
  name: OWNER_WRITE,
  description: "Test-only stand-in for an owner answer",
  args: z.object({ answer: z.string() }),
  result: z.object({ answer: z.string(), issuedAt: z.number() }),
  run: async ({ answer }, ctx) => {
    ran.push({ command: OWNER_WRITE, issuedAt: ctx.ownerPresence.issuedAt });
    return { answer, issuedAt: ctx.ownerPresence.issuedAt };
  },
});

const stubDeposit = depositCommand({
  name: DEPOSIT,
  description: "Test-only stand-in for an inbox deposit",
  args: z.object({}),
  result: z.object({ deposited: z.boolean() }),
  run: async () => {
    ran.push({ command: DEPOSIT });
    return { deposited: true };
  },
});

function context(surface: ConsoleSurface, auth: RequestAuth | null, ownerWrites = true): ConsoleContext {
  return { warnings: [], format: "json", surface, auth, ownerWrites };
}

const SESSION_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };

beforeEach(() => {
  ran = [];
});

describe("the owner-write class", () => {
  it.each([
    ["loopback with no credential", context("http", null), REFUSALS.noCredential],
    ["a bearer on the LAN", context("http", { credential: "bearer", issuedAt: null, peerLocal: false }), REFUSALS.bearer],
    ["a session while owner writes are off", context("http", SESSION_AUTH, false), REFUSALS.disabled],
    ["a session from this machine's own address", context("http", { ...SESSION_AUTH, peerLocal: true }), REFUSALS.peerLocal],
    ["MCP", context("mcp", null), REFUSALS.notHttp],
    ["an in-process call", context("in-process", SESSION_AUTH), REFUSALS.notHttp],
  ])("refuses %s with NOPERM and a reason naming the class", async (_label, ctx, reason) => {
    const { envelope, exitCode } = await invokeCommand(stubOwnerWrite, { answer: "yes" }, ctx);

    expect(exitCode).toBe(EXIT.NOPERM);
    expect(envelope).toEqual({ ok: false, error: `owner-write command refused: ${reason}`, code: EXIT.NOPERM });
    expect(ran).toEqual([]);
  });

  it("runs for a remote session with owner writes on, and hands the handler the session's issuedAt", async () => {
    const { envelope } = await invokeCommand(stubOwnerWrite, { answer: "yes" }, context("http", SESSION_AUTH));

    expect(envelope).toEqual({ ok: true, data: { answer: "yes", issuedAt: 1_000 } });
    expect(ran).toEqual([{ command: OWNER_WRITE, issuedAt: 1_000 }]);
  });
});

describe("the deposit and read classes", () => {
  it("runs a deposit on loopback and with either LAN credential, and refuses one outside HTTP", async () => {
    const http = [context("http", null), context("http", SESSION_AUTH), context("http", { credential: "bearer", issuedAt: null, peerLocal: true })];
    const replies = await Promise.all(http.map((ctx) => invokeCommand(stubDeposit, {}, ctx)));
    const mcp = await invokeCommand(stubDeposit, {}, context("mcp", null));

    expect(replies.map(({ envelope }) => envelope.ok)).toEqual([true, true, true]);
    expect(mcp.envelope).toEqual({ ok: false, error: `deposit command refused: ${REFUSALS.notHttp}`, code: EXIT.NOPERM });
  });

  it("leaves a read command's run untouched", () => {
    const read = readCommand(stubDeposit);

    expect(read.commandClass).toBe("read");
    expect(read.run).toBe(stubDeposit.run);
  });
});

// Linux routes all of 127/8 to lo; macOS answers only 127.0.0.1 unless an alias is added.
describe.skipIf(process.platform !== "linux")("owner-write over the console's listeners (127.0.0.2 stands in for the LAN)", () => {
  const NAME = "lan-box";
  const json = { "content-type": "application/json" };
  let dir: string;
  let activeWork: FakeDaemon;
  let handle: DaemonHandle | undefined;
  let port: number;
  let config: ConsoleConfig;
  let replies: Reply[];
  let secrets: string[];
  let token: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "console-owner-guard-"));
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
      lanHost: LAN,
      lanNames: [NAME],
      lanTokenPath: path.join(dir, "state", "lan.token"),
      ownerWrites: true,
    };
    await writeFile(config.sessionGraphPath, "synthetic");
    replies = [];
    secrets = [];
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    await activeWork.close();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * One machine cannot be its own remote peer: every request here arrives from loopback, so the
   * gate records peerLocal true. A test of what another device may do overrides that one fact.
   */
  function asRemotePeer(): void {
    vi.mocked(daemonPackage.startDaemon).mockImplementationOnce(async (options) => {
      const { startDaemon } = await vi.importActual<typeof daemonPackage>("@titan-design/daemon");
      return startDaemon({ ...options, createContext: (surface, auth) => options.createContext(surface, auth && { ...auth, peerLocal: false }) });
    });
  }

  async function start(overrides: Partial<ConsoleConfig> = {}): Promise<void> {
    handle = await startConsoleDaemon({ config: { ...config, ...overrides }, extraCommands: [stubOwnerWrite, stubDeposit], logger: silentLogger });
    port = handle.port;
    config = { ...config, ...overrides, port };
    token = readFileSync(config.lanTokenPath, "utf8").trim();
    secrets.push(token);
  }

  async function record(reply: Promise<Reply>): Promise<Reply> {
    const settled = await reply;
    replies.push(settled);
    return settled;
  }

  const sameOrigin = (): Record<string, string> => ({ origin: `http://${NAME}:${port}` });
  const lan = (method: string, route: string, headers: Record<string, string>, body?: string): Promise<Reply> =>
    record(send(LAN, port, method, route, { host: `${NAME}:${port}`, ...headers }, body));
  const lanRpc = (command: string, headers: Record<string, string>, args: unknown = {}): Promise<Reply> =>
    lan("POST", `/rpc/${command}`, { ...json, ...sameOrigin(), ...headers }, JSON.stringify(args));
  const loopbackRpc = (command: string, headers: Record<string, string> = { "x-titan-client": "test" }): Promise<Reply> =>
    record(send("127.0.0.1", port, "POST", `/rpc/${command}`, { ...json, ...headers }, JSON.stringify({ answer: "yes" })));
  const bearer = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

  /** Follows a login-link the way the sign-in page does, keeping the code and cookie to check for leaks. */
  async function signIn(): Promise<{ cookie: string }> {
    const code = new URL(createLoginLink(config)).searchParams.get("code") ?? "";
    secrets.push(code);
    const login = await send(LAN, port, "POST", "/auth/login", { host: `${NAME}:${port}`, ...json, ...sameOrigin() }, JSON.stringify({ code }));
    const cookie = sessionCookie(login)!.split(";")[0]!;
    secrets.push(cookie.slice(cookie.indexOf("=") + 1));
    return { cookie };
  }

  const errorOf = (reply: Reply): string => (JSON.parse(reply.body) as { error: string }).error;

  function expectNoSecretInAnyReply(): void {
    const leaked = replies.filter((reply) => secrets.some((secret) => reply.body.includes(secret) || JSON.stringify(reply.headers).includes(secret)));
    expect(leaked).toEqual([]);
  }

  it("answers 403 on loopback, 403 with a bearer, and 200 with a cookie from login-link", async () => {
    asRemotePeer();
    await start();
    const cookie = await signIn();
    const issuedAt = Number(/v1\.(\d+)\./.exec(cookie.cookie)![1]);

    const loopback = await loopbackRpc(OWNER_WRITE);
    const withBearer = await lanRpc(OWNER_WRITE, bearer(), { answer: "yes" });
    const withCookie = await lanRpc(OWNER_WRITE, cookie, { answer: "yes" });

    expect([loopback.status, withBearer.status, withCookie.status]).toEqual([403, 403, 200]);
    expect(errorOf(loopback)).toBe(`owner-write command refused: ${REFUSALS.noCredential}`);
    expect(errorOf(withBearer)).toBe(`owner-write command refused: ${REFUSALS.bearer}`);
    expect(JSON.parse(withCookie.body)).toEqual({ ok: true, data: { answer: "yes", issuedAt } });
    expect(ran).toEqual([{ command: OWNER_WRITE, issuedAt }]);
    expectNoSecretInAnyReply();
  });

  it("answers 403 to a cookie POST from a cross-site Origin before the command runs", async () => {
    asRemotePeer();
    await start();
    const cookie = await signIn();

    const crossSite = await lanRpc(OWNER_WRITE, { ...cookie, origin: "http://evil.example" }, { answer: "yes" });
    const otherPort = await lanRpc(OWNER_WRITE, { ...cookie, origin: `http://${NAME}:${port + 1}` }, { answer: "yes" });

    expect([crossSite.status, otherPort.status]).toEqual([403, 403]);
    expect(ran).toEqual([]);
    expectNoSecretInAnyReply();
  });

  it("refuses every owner write while TITAN_CONSOLE_OWNER_WRITES is off", async () => {
    asRemotePeer();
    await start({ ownerWrites: false });
    const cookie = await signIn();

    const withCookie = await lanRpc(OWNER_WRITE, cookie, { answer: "yes" });

    expect(withCookie.status).toBe(403);
    expect(errorOf(withCookie)).toBe("owner-write command refused: owner writes disabled until TLS");
    expect(ran).toEqual([]);
    expectNoSecretInAnyReply();
  });

  it("refuses a valid cookie from this machine's own address, as an agent minting a login link would send", async () => {
    await start();
    const cookie = await signIn();

    const fromHere = await lanRpc(OWNER_WRITE, cookie, { answer: "yes" });

    expect(fromHere.status).toBe(403);
    expect(errorOf(fromHere)).toBe(`owner-write command refused: ${REFUSALS.peerLocal}`);
    expect(ran).toEqual([]);
    expectNoSecretInAnyReply();
  });

  it("serves no owner-write command by GET", async () => {
    asRemotePeer();
    await start();
    const cookie = await signIn();

    const get = await lan("GET", `/rpc/${OWNER_WRITE}`, { ...cookie, accept: "application/json" });

    expect(get.status).toBe(404);
    expect(ran).toEqual([]);
  });

  it("runs a deposit on loopback with X-Titan-Client and with either LAN credential", async () => {
    await start();
    const cookie = await signIn();

    const loopback = await loopbackRpc(DEPOSIT);
    const bare = await loopbackRpc(DEPOSIT, {});
    const withBearer = await lanRpc(DEPOSIT, bearer());
    const withCookie = await lanRpc(DEPOSIT, cookie);
    const anonymous = await lanRpc(DEPOSIT, {});

    expect([loopback.status, bare.status, withBearer.status, withCookie.status, anonymous.status]).toEqual([200, 403, 200, 200, 401]);
    expect(ran.map(({ command }) => command)).toEqual([DEPOSIT, DEPOSIT, DEPOSIT]);
    expectNoSecretInAnyReply();
  });

  it("classes every console command as a read and keeps reads open on loopback", async () => {
    await start();

    const health = await loopbackRpc("upstreams.health");

    expect(health.status).toBe(200);
    expect(createConsoleRegistry(createSources(config)).list().map((command) => (command as { commandClass?: string }).commandClass)).toSatisfy(
      (classes: unknown[]) => classes.length > 0 && classes.every((commandClass) => commandClass === "read"),
    );
  });
});
