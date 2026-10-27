import { afterEach, describe, expect, it } from "vitest";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { activeWorkClient, failure } from "./active-work.js";
import { brokerReader } from "./broker.js";
import { consoleCommands } from "./commands.js";
import { fixtureAnswer, type FixtureOptions } from "./fixtures.js";
import { REFUSALS, type ConsoleContext } from "./owner-guard.js";
import { shepherdReader } from "./shepherd.js";
import { closedPort, startFakeDaemon, type FakeDaemon } from "./test-support.js";
import type { WorkOptions } from "./work.js";
import { loopBoardResult } from "./work-loops.js";

const NO_AGENTS = { broker: brokerReader({ port: 1, tokenPath: "/nonexistent/ui.token" }), eventsDbPath: "/nonexistent/events.db", seatPrefixes: [] };
const NO_SESSIONS = { graphPath: "/nonexistent/graph.sqlite3" };

const LOOPBACK: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: null, ownerWrites: true };
const OWNER: ConsoleContext = { ...LOOPBACK, auth: { credential: "session", issuedAt: 1_000, peerLocal: false } };

let daemon: FakeDaemon | undefined;
let calls: { command: string; args: Record<string, unknown> }[] = [];

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  calls = [];
});

/** The synthetic active-work daemon on loopback; `served: false` imitates one older than the `loop.*` commands. */
async function fakeActiveWork(served = true, options: FixtureOptions = {}) {
  daemon = await startFakeDaemon({ ok: true }, (command, args) => {
    calls.push({ command, args });
    if (!served && command.startsWith("loop.")) throw failure(`Unknown command: ${command}`, EXIT.USAGE);
    return fixtureAnswer(command, args, options);
  });
  return activeWorkClient(daemon.port);
}

function commandsOver(activeWork: ReturnType<typeof activeWorkClient>, work?: WorkOptions) {
  return consoleCommands({ upstreams: [], agents: NO_AGENTS, sessions: NO_SESSIONS, inbox: { dir: "/nonexistent/inbox" }, rounds: { dir: "/nonexistent/rounds" }, shepherd: shepherdReader(1), activeWork, work });
}

/** The `work.loops` answer, or null when the command answered an error. */
async function readBoard(ctx: ConsoleContext, options: { served?: boolean; work?: WorkOptions } = {}) {
  const commands = commandsOver(await fakeActiveWork(options.served), options.work);
  const { envelope } = await invokeCommand(commands["work.loops"], {}, ctx);
  return envelope.ok ? loopBoardResult.parse(envelope.data) : null;
}

describe("work.loops", () => {
  it("serves the board active-work's loop.board answers", async () => {
    const read = await readBoard(OWNER);

    expect(read?.board?.loops.map((loop) => loop.id)).toContain("loop-a");
    expect(read?.unavailable).toBeNull();
    expect(calls.map((call) => call.command)).toEqual(["loop.board"]);
  });

  it("reports an old active-work daemon as unavailable, not as an empty board", async () => {
    const read = await readBoard(OWNER, { served: false });

    expect(read && { board: read.board, unavailable: read.unavailable }).toEqual({ board: null, unavailable: "active-work ≥ 0.23 needed" });
  });

  it("answers an error when the daemon is down, never an empty or unavailable board", async () => {
    const commands = commandsOver(activeWorkClient(await closedPort()));

    const { envelope } = await invokeCommand(commands["work.loops"], {}, OWNER);

    expect(envelope.ok ? null : envelope.code).toBe(EXIT.UNAVAILABLE);
  });

  it("names the owner guard's refusal for a loopback caller, and none for the owner on the LAN", async () => {
    const loopback = await readBoard(LOOPBACK);
    const owner = await readBoard(OWNER);

    expect([loopback?.tierWritesOff, owner?.tierWritesOff]).toEqual([REFUSALS.noCredential, null]);
  });

  it("leaves a personal initiative's loops out when personal initiatives are excluded", async () => {
    const read = await readBoard(OWNER, { work: { excludePersonal: true } });

    const initiatives = new Set(read?.board?.loops.map((loop) => loop.initiative));
    expect([initiatives.has("orbit-relay"), initiatives.has("garden-plan")]).toEqual([true, false]);
  });
});

describe("work.loop-tier", () => {
  const MOVE = { id: "loop-c", tier: "S", before: "loop-b" };

  it("refuses on loopback because it is an owner write", async () => {
    const commands = commandsOver(await fakeActiveWork());

    const { envelope } = await invokeCommand(commands["work.loop-tier"], MOVE, LOOPBACK);

    expect(envelope.ok ? "ran" : envelope.error).toContain(REFUSALS.noCredential);
    expect(calls).toEqual([]);
  });

  it("passes the owner's move to active-work's loop.tier and answers the new tier", async () => {
    const commands = commandsOver(await fakeActiveWork());

    const { envelope } = await invokeCommand(commands["work.loop-tier"], MOVE, OWNER);

    expect(calls).toEqual([{ command: "loop.tier", args: MOVE }]);
    expect(envelope.ok ? envelope.data : envelope.error).toMatchObject({ id: "loop-c", tier: "S" });
  });
});
