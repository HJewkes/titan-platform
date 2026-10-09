import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as NetModule from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import * as daemonPackage from "@titan-design/daemon";
import { silentLogger, type DaemonHandle, type RequestAuth } from "@titan-design/daemon";
import { EXIT, defineCommand, invokeCommand, type AnyCommand, type Command } from "@titan-design/registry";
import type { ConsoleConfig } from "./config.js";
import { createLoginLink, rotateLanToken, startConsoleDaemon } from "./daemon.js";
import { fixtureAnswer } from "./fixtures.js";
import {
  REFUSALS,
  depositCommand,
  ownerWriteCommand,
  readCommand,
  type ClassedCommand,
  type ConsoleContext,
  type ConsoleSurface,
} from "./owner-guard.js";
import { createConsoleRegistry } from "./registry.js";
import { closedPort, send, sessionCookie, startFakeDaemon, writeSelfSignedCert, type FakeDaemon, type Reply, type SelfSignedPair } from "./test-support.js";
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

type OwnerAnswerContext = ConsoleContext & { ownerPresence: { issuedAt: number } };

const ownerAnswer = {
  name: OWNER_WRITE,
  description: "Test-only stand-in for an owner answer",
  args: z.object({ answer: z.string() }),
  result: z.object({ answer: z.string(), issuedAt: z.number() }),
  ownerWrite: true as const,
  run: async ({ answer }: { answer: string }, ctx: OwnerAnswerContext) => {
    ran.push({ command: OWNER_WRITE, issuedAt: ctx.ownerPresence.issuedAt });
    return { answer, issuedAt: ctx.ownerPresence.issuedAt };
  },
};

const stubOwnerWrite = ownerWriteCommand(ownerAnswer);

const needsPresence = defineCommand<Record<string, never>, { ok: boolean }, OwnerAnswerContext>({
  name: "test.needs-presence",
  description: "Test-only handler that reads the presence proof but carries no owner-write mark",
  args: z.object({}),
  result: z.object({ ok: z.boolean() }),
  run: async (_args, ctx) => ({ ok: ctx.ownerPresence.issuedAt > 0 }),
});

type OptionalPresenceContext = ConsoleContext & { ownerPresence?: { issuedAt: number } };

const optionalPresence = defineCommand<Record<string, never>, { present: boolean }, OptionalPresenceContext>({
  name: "test.optional-presence",
  description: "Test-only handler that treats the presence proof as optional and carries no mark",
  args: z.object({}),
  result: z.object({ present: z.boolean() }),
  run: async (_args, ctx) => ({ present: ctx.ownerPresence !== undefined }),
});

type EitherPresenceContext = ConsoleContext | OwnerAnswerContext;

const eitherPresence = defineCommand<Record<string, never>, { present: boolean }, EitherPresenceContext>({
  name: "test.either-presence",
  description: "Test-only handler whose context may or may not carry the presence proof, with no mark",
  args: z.object({}),
  result: z.object({ present: z.boolean() }),
  run: async (_args, ctx) => ({ present: "ownerPresence" in ctx }),
});

/**
 * Each way a handler reaches a helper typed as a console command. None compiles, because `run` is a
 * property; the runtime tests below stand in for a caller that casts past the types instead.
 */
function widenings<Args, Result>(handler: Command<Args, Result, OwnerAnswerContext>): Array<[string, AnyCommand<ConsoleContext>]> {
  // @ts-expect-error a console-context annotation cannot hold a run that needs the presence proof
  const annotated: Command<Args, Result, ConsoleContext> = handler;
  // @ts-expect-error nor can an AnyCommand annotation
  const asAny: AnyCommand<ConsoleContext> = handler;
  // @ts-expect-error nor a factory's return type
  const fromFactory = (): Command<Args, Result, ConsoleContext> => handler;
  // @ts-expect-error nor an AnyCommand array
  const list: AnyCommand<ConsoleContext>[] = [handler];
  return [
    ["a console-context annotation", annotated],
    ["an AnyCommand annotation", asAny],
    ["a factory's return type", fromFactory()],
    ["an AnyCommand array", list[0]!],
  ];
}

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

const UNCLASSED = "test.unclassed";
const unclassed = defineCommand<Record<string, never>, { ok: boolean }, ConsoleContext>({
  name: UNCLASSED,
  description: "Test-only command defined without a class",
  args: z.object({}),
  result: z.object({ ok: z.boolean() }),
  run: async () => ({ ok: true }),
});

/** Sources only hold ports and paths until a command runs, so none of these is opened. */
function syntheticConfig(): ConsoleConfig {
  return {
    port: 0,
    stateDir: "/nonexistent/state",
    activeWorkPort: 1,
    agentChatPort: 1,
    agentChatTokenPath: "/nonexistent/ui.token",
    agentChatEventsDbPath: "/nonexistent/events.db",
    seatPrefixes: [],
    sessionGraphPath: "/nonexistent/graph.sqlite3",
    codewatchUrl: "http://codewatch.test:7433",
    lanHost: null,
    lanNames: [],
    lanTls: null,
    lanTokenPath: "/nonexistent/lan.token",
    ownerWrites: false,
    inboxDir: "/nonexistent/inbox",
  };
}

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
    const read = readCommand(unclassed);

    expect(read.commandClass).toBe("read");
    expect(read.run).toBe(unclassed.run);
  });
});

describe("classes fail closed", () => {
  it.each([
    ["an owner-write as a read", () => readCommand(stubOwnerWrite), "read"],
    ["a deposit as a read", () => readCommand(stubDeposit), "read"],
    ["a read as a deposit", () => depositCommand(readCommand(unclassed)), "deposit"],
    ["a deposit as an owner-write", () => ownerWriteCommand(stubDeposit as never), "owner-write"],
    ["a spread copy of an owner-write as a read", () => readCommand({ ...stubOwnerWrite }), "read"],
  ])("refuses to re-class %s", (_label, reclass, commandClass) => {
    expect(reclass).toThrow(new RegExp(`already classed; it cannot be re-classed as ${commandClass}$`));
  });

  it("refuses, at compile time and at definition, an owner-write handler wrapped as a read or a deposit", () => {
    // @ts-expect-error a read cannot wrap a handler whose run takes the owner-write context
    const asRead = () => readCommand(ownerAnswer);
    // @ts-expect-error a deposit cannot wrap a handler whose run takes the owner-write context
    const asDeposit = () => depositCommand(ownerAnswer);

    expect(asRead).toThrow(`Console command ${OWNER_WRITE} is an owner-write handler; it cannot be served as read, only through ownerWriteCommand`);
    expect(asDeposit).toThrow(`Console command ${OWNER_WRITE} is an owner-write handler; it cannot be served as deposit, only through ownerWriteCommand`);
  });

  it("fails to compile a read or a deposit whose run needs the owner's presence proof, even without the mark", () => {
    // Type-only: with no mark there is nothing for the runtime guard to see, so neither wrapper is called.
    // @ts-expect-error the console context carries no presence proof, so it cannot satisfy this run
    expectTypeOf(() => readCommand(needsPresence)).toBeFunction();
    // @ts-expect-error the console context carries no presence proof, so it cannot satisfy this run
    expectTypeOf(() => depositCommand(needsPresence)).toBeFunction();
  });

  it("fails to compile the owner-write handler itself widened to a console command", () => {
    // @ts-expect-error the handler's run needs the presence proof a console context lacks
    const annotated: Command<{ answer: string }, { answer: string; issuedAt: number }, ConsoleContext> = ownerAnswer;
    // @ts-expect-error the same for an AnyCommand array
    const list: AnyCommand<ConsoleContext>[] = [ownerAnswer];

    expect([annotated, ...list]).toEqual([ownerAnswer, ownerAnswer]);
  });

  it("fails to compile a read or a deposit whose presence is optional, even without the mark", () => {
    // Type-only, as above: unmarked, so the runtime guard has nothing to see.
    // @ts-expect-error the console context has no ownerPresence key, so a run that reads one is refused
    expectTypeOf(() => readCommand(optionalPresence)).toBeFunction();
    // @ts-expect-error the console context has no ownerPresence key, so a run that reads one is refused
    expectTypeOf(() => depositCommand(optionalPresence)).toBeFunction();
  });

  it("fails to compile a read or a deposit whose context is a union with one member carrying presence", () => {
    // keyof a union sees only the shared keys, so the check must look at each member's keys.
    // @ts-expect-error one member of the context union has an ownerPresence key the console lacks
    expectTypeOf(() => readCommand(eitherPresence)).toBeFunction();
    // @ts-expect-error one member of the context union has an ownerPresence key the console lacks
    expectTypeOf(() => depositCommand(eitherPresence)).toBeFunction();
  });

  it.each(widenings(ownerAnswer))("refuses at runtime a marked owner-write handler widened by %s", (_label, widened) => {
    expect(() => readCommand(widened)).toThrow(`Console command ${OWNER_WRITE} is an owner-write handler; it cannot be served as read`);
    expect(() => depositCommand(widened)).toThrow(`Console command ${OWNER_WRITE} is an owner-write handler; it cannot be served as deposit`);
  });

  it.each(widenings(needsPresence))("fails closed when an unmarked handler needing presence is widened by %s and run", async (_label, widened) => {
    const replies = await Promise.all([
      invokeCommand(readCommand(widened), {}, context("http", SESSION_AUTH)),
      invokeCommand(depositCommand(widened), {}, context("http", SESSION_AUTH)),
    ]);

    expect(replies.map(({ envelope }) => envelope.ok)).toEqual([false, false]);
  });

  it("never hands the presence proof to an optional-presence handler widened before it is classed", async () => {
    // TypeScript has no exact types, so a console context still satisfies an optional key once the
    // handler's own type is gone; what the console guarantees is that only ownerWriteCommand adds the proof.
    const widened: Command<Record<string, never>, { present: boolean }, ConsoleContext> = optionalPresence;

    const replies = await Promise.all([
      invokeCommand(readCommand(widened), {}, context("http", SESSION_AUTH)),
      invokeCommand(depositCommand(widened), {}, context("http", SESSION_AUTH)),
    ]);

    expect(replies.map(({ envelope }) => envelope)).toEqual([
      { ok: true, data: { present: false } },
      { ok: true, data: { present: false } },
    ]);
  });

  it("fails startup on an owner-write handler hand-classed as a read", () => {
    const handClassed = { ...ownerAnswer, commandClass: "read" } as unknown as ClassedCommand;

    expect(() => createConsoleRegistry(createSources(syntheticConfig()), [handClassed])).toThrow(
      `Console command ${OWNER_WRITE} is an owner-write handler; it cannot be served as read, only through ownerWriteCommand`,
    );
  });

  it("fails startup naming a command with no class", () => {
    const sources = createSources(syntheticConfig());

    expect(() => createConsoleRegistry(sources, [unclassed as ClassedCommand])).toThrow(`Console command ${UNCLASSED} has no class`);
    expect(() => createConsoleRegistry(sources, [{ ...unclassed, commandClass: "owner_write" } as unknown as ClassedCommand])).toThrow(
      `Console command ${UNCLASSED} has no class`,
    );
  });

  it("classes every console command at its definition: inbox.deposit a deposit, the rest reads", () => {
    const classes = createConsoleRegistry(createSources(syntheticConfig()))
      .list()
      .map((command) => [command.name, (command as ClassedCommand).commandClass]);

    expect(classes.length).toBeGreaterThan(1);
    expect(classes.filter(([, commandClass]) => commandClass !== "read")).toEqual([["inbox.deposit", "deposit"]]);
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
  let pair: SelfSignedPair;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "console-owner-guard-"));
    pair = writeSelfSignedCert(dir, [NAME, LAN]);
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
      lanTls: { certFile: pair.certFile, keyFile: pair.keyFile },
      lanTokenPath: path.join(dir, "state", "lan.token"),
      ownerWrites: true,
      inboxDir: path.join(dir, "state", "inbox", "deposits"),
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

  const sameOrigin = (): Record<string, string> => ({ origin: `https://${NAME}:${port}` });
  const lan = (method: string, route: string, headers: Record<string, string>, body?: string): Promise<Reply> =>
    record(send(LAN, port, method, route, { host: `${NAME}:${port}`, ...headers }, body, { ca: pair.cert, servername: NAME }));
  const lanRpc = (command: string, headers: Record<string, string>, args: unknown = {}): Promise<Reply> =>
    lan("POST", `/rpc/${command}`, { ...json, ...sameOrigin(), ...headers }, JSON.stringify(args));
  const loopbackRpc = (command: string, headers: Record<string, string> = { "x-titan-client": "test" }): Promise<Reply> =>
    record(send("127.0.0.1", port, "POST", `/rpc/${command}`, { ...json, ...headers }, JSON.stringify({ answer: "yes" })));
  const bearer = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

  /** Follows a login-link the way the sign-in page does, keeping the code and cookie to check for leaks. */
  async function signIn(): Promise<{ cookie: string }> {
    const code = new URL(createLoginLink(config)).searchParams.get("code") ?? "";
    secrets.push(code);
    const login = await send(LAN, port, "POST", "/auth/login", { host: `${NAME}:${port}`, ...json, ...sameOrigin() }, JSON.stringify({ code }), { ca: pair.cert, servername: NAME });
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
    const otherPort = await lanRpc(OWNER_WRITE, { ...cookie, origin: `https://${NAME}:${port + 1}` }, { answer: "yes" });

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
    expect(errorOf(withCookie)).toBe("owner-write command refused: owner writes are off");
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

  it("keeps reads open on loopback", async () => {
    await start();

    const health = await loopbackRpc("upstreams.health");

    expect(health.status).toBe(200);
  });

  it("answers 403 to a bearer and a session cookie sent together, since the bearer cannot answer for the owner", async () => {
    asRemotePeer();
    await start();
    const cookie = await signIn();

    const both = await lanRpc(OWNER_WRITE, { ...bearer(), ...cookie }, { answer: "yes" });

    expect(both.status).toBe(403);
    expect(errorOf(both)).toBe(`owner-write command refused: ${REFUSALS.bearer}`);
    expect(ran).toEqual([]);
    expectNoSecretInAnyReply();
  });

  it("refuses an owner write with a cookie minted before token rotate, and runs one with a cookie minted after", async () => {
    asRemotePeer();
    await start();
    const before = await signIn();

    rotateLanToken(config);
    secrets.push(readFileSync(config.lanTokenPath, "utf8").trim());
    const stale = await lanRpc(OWNER_WRITE, before, { answer: "yes" });
    const after = await lanRpc(OWNER_WRITE, await signIn(), { answer: "yes" });

    expect([stale.status, after.status]).toEqual([401, 200]);
    expect(ran.map(({ command }) => command)).toEqual([OWNER_WRITE]);
    expectNoSecretInAnyReply();
  });

  it("refuses to start with an unclassed command, naming it, and serves nothing", async () => {
    const startsBefore = vi.mocked(daemonPackage.startDaemon).mock.calls.length;

    const starting = startConsoleDaemon({ config, extraCommands: [stubDeposit, unclassed as ClassedCommand], logger: silentLogger });

    await expect(starting).rejects.toThrow(`Console command ${UNCLASSED} has no class`);
    expect(vi.mocked(daemonPackage.startDaemon).mock.calls.length).toBe(startsBefore);
  });
});
