import { afterEach, describe, expect, it } from "vitest";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { activeWorkClient, type ActiveWork } from "./active-work.js";
import { brokerReader } from "./broker.js";
import { consoleCommands } from "./commands.js";
import { REFUSALS, type ConsoleContext } from "./owner-guard.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

const NO_AGENTS = { broker: brokerReader({ port: 1, tokenPath: "/nonexistent/ui.token" }), eventsDbPath: "/nonexistent/events.db", seatPrefixes: [] };

const LOOPBACK: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: null, ownerWrites: true };
const OWNER: ConsoleContext = { ...LOOPBACK, auth: { credential: "session", issuedAt: 1_000, peerLocal: false } };
const OWNER_WRITES_OFF: ConsoleContext = { ...OWNER, ownerWrites: false };

const TASK = { slug: "orbit-relay", id: "OR-1" };

let daemon: FakeDaemon | undefined;
let calls: { command: string; args: Record<string, unknown> }[] = [];

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  calls = [];
});

/** A synthetic active-work daemon that answers task.done and task.edit with the whole task, as the real one does. */
async function fakeWriter(): Promise<ActiveWork> {
  daemon = await startFakeDaemon({ ok: true }, (command, args) => {
    calls.push({ command, args });
    return { id: args.id, title: "Extra fields are dropped", status: command === "task.done" ? "done" : "open" };
  });
  return activeWorkClient(daemon.port);
}

function commandsOver(activeWork: ActiveWork) {
  return consoleCommands({ upstreams: [], agents: NO_AGENTS, sessions: { graphPath: "/nonexistent/graph.sqlite3" }, inbox: { dir: "/nonexistent/inbox" }, rounds: { dir: "/nonexistent/rounds" }, shepherd: shepherdReader(1), activeWork });
}

describe("work.task-done", () => {
  it("refuses on loopback because it is an owner write", async () => {
    const commands = commandsOver(await fakeWriter());

    const { envelope } = await invokeCommand(commands["work.task-done"], TASK, LOOPBACK);

    expect(envelope.ok ? "ran" : envelope.error).toContain(REFUSALS.noCredential);
    expect(calls).toEqual([]);
  });

  it("refuses without owner writes even for the owner", async () => {
    const commands = commandsOver(await fakeWriter());

    const { envelope } = await invokeCommand(commands["work.task-done"], TASK, OWNER_WRITES_OFF);

    expect(envelope.ok ? "ran" : envelope.error).toContain(REFUSALS.disabled);
    expect(calls).toEqual([]);
  });

  it("marks the task done through task.done, then undo reopens it through task.edit on status", async () => {
    const command = commandsOver(await fakeWriter())["work.task-done"];

    const done = await invokeCommand(command, TASK, OWNER);
    const undone = await invokeCommand(command, { ...TASK, undo: true }, OWNER);

    expect(calls).toEqual([
      { command: "task.done", args: TASK },
      { command: "task.edit", args: { ...TASK, field: "status", value: "open" } },
    ]);
    expect([done.envelope.ok && done.envelope.data, undone.envelope.ok && undone.envelope.data]).toEqual([
      { id: "OR-1", status: "done" },
      { id: "OR-1", status: "open" },
    ]);
  });

  it("answers EXIT.UNAVAILABLE from a read-only source", async () => {
    const readOnly: ActiveWork = { read: () => Promise.reject(new Error("no reads")) };

    const { envelope } = await invokeCommand(commandsOver(readOnly)["work.task-done"], TASK, OWNER);

    expect(envelope.ok ? null : envelope.code).toBe(EXIT.UNAVAILABLE);
  });
});
