import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerExitedError,
  CodexSteerPreconditionError,
  startCodexAppServer,
  type CodexAppServer,
  type CodexAppServerEvent,
} from "./codex-app-server.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
const text = (value: string) => [{ type: "text" as const, text: value }];
const servers: CodexAppServer[] = [];
const dirs: string[] = [];

async function start(...flags: string[]) {
  const server = await startCodexAppServer({
    executablePath: process.execPath,
    args: [FAKE, ...flags],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "" },
  });
  servers.push(server);
  const events: CodexAppServerEvent[] = [];
  server.onEvent((event) => events.push(event));
  const turnCompleted = () =>
    new Promise<void>((resolve) => {
      const stop = server.onEvent((event) => {
        if (event.kind !== "turn_completed") return;
        stop();
        resolve();
      });
    });
  return { server, events, turnCompleted };
}

async function logFile() {
  const dir = await mkdtemp(join(tmpdir(), "codex-app-server-test-"));
  dirs.push(dir);
  return join(dir, "received.jsonl");
}

async function received(path: string) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
}

const userMessage = (value: string) =>
  expect.objectContaining({
    item: { type: "userMessage", content: [{ type: "text", text: value }] },
  });

const kinds = (events: CodexAppServerEvent[]) =>
  events.filter((event) => event.kind !== "notification").map((e) => e.kind);

const steeredTexts = (events: CodexAppServerEvent[]) =>
  events.flatMap((event) => (event.kind === "notification" && event.method === "item/completed" ? [event.params] : []));

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close("SIGKILL")));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("codex app-server client", () => {
  it("completes the initialize handshake and starts a thread", async () => {
    const log = await logFile();
    const { server } = await start("--log", log);

    const result = await server.threadStart({ cwd: "/work" });

    expect(server.initialized.platformFamily).toBe("unix");
    expect(result).toMatchObject({
      threadId: "01a15a00-0000-7000-8000-000000000001",
      cwd: "/work",
    });
    expect(await received(log)).toEqual([
      expect.objectContaining({ method: "initialize" }),
      expect.objectContaining({ method: "initialized" }),
      expect.objectContaining({ method: "thread/start" }),
    ]);
  });

  it("resumes a thread by id", async () => {
    const { server } = await start();

    const result = await server.threadResume("01a15a00-0000-7000-8000-000000000002");

    expect(result.threadId).toBe("01a15a00-0000-7000-8000-000000000002");
  });

  it("starts a turn on an idle thread and reports its lifecycle", async () => {
    const { server, events, turnCompleted } = await start();
    const { threadId } = await server.threadStart();
    const completed = turnCompleted();

    const { turnId } = await server.turnStart({
      threadId,
      input: text("hello"),
    });
    await completed;

    expect(turnId).toBe("turn-1");
    expect(kinds(events)).toEqual(["thread_status", "turn_started", "thread_status", "turn_completed"]);
    expect(events.at(-1)).toEqual({
      kind: "turn_completed",
      threadId,
      turnId,
      status: "completed",
    });
    expect(events.at(-2)).toMatchObject({
      kind: "thread_status",
      status: "idle",
    });
  });

  it("accepts a steer mid-turn", async () => {
    const { server, events, turnCompleted } = await start("--steers-to-complete", "1");
    const { threadId } = await server.threadStart();
    const { turnId } = await server.turnStart({
      threadId,
      input: text("work"),
    });
    const completed = turnCompleted();

    const steer = await server.turnSteer({
      threadId,
      expectedTurnId: turnId,
      input: text("from peer"),
    });
    await completed;

    expect(steer).toEqual({ turnId });
    expect(steeredTexts(events)).toEqual([userMessage("from peer")]);
  });

  it("delivers two steers in the order they were sent", async () => {
    const { server, events, turnCompleted } = await start("--steers-to-complete", "2");
    const { threadId } = await server.threadStart();
    const { turnId } = await server.turnStart({
      threadId,
      input: text("work"),
    });
    const params = { threadId, expectedTurnId: turnId };
    const completed = turnCompleted();

    await Promise.all([
      server.turnSteer({ ...params, input: text("STEER-1") }),
      server.turnSteer({ ...params, input: text("STEER-2") }),
    ]);
    await completed;

    expect(steeredTexts(events)).toEqual([userMessage("STEER-1"), userMessage("STEER-2")]);
    expect(events.at(-1)).toMatchObject({ kind: "turn_completed", turnId });
  });

  it("raises a typed precondition error when no turn is active, so the caller can start one", async () => {
    const { server, turnCompleted } = await start();
    const { threadId } = await server.threadStart();
    const completed = turnCompleted();
    const { turnId } = await server.turnStart({
      threadId,
      input: text("done quickly"),
    });
    await completed;

    const steer = server.turnSteer({
      threadId,
      expectedTurnId: turnId,
      input: text("late"),
    });

    await expect(steer).rejects.toBeInstanceOf(CodexSteerPreconditionError);
    await expect(steer).rejects.toMatchObject({
      code: -32600,
      method: "turn/steer",
    });
    await expect(server.turnStart({ threadId, input: text("late") })).resolves.toEqual({ turnId: "turn-2" });
  });

  it("raises the precondition error when a different turn is active", async () => {
    const { server } = await start("--steers-to-complete", "1");
    const { threadId } = await server.threadStart();
    await server.turnStart({ threadId, input: text("work") });

    const steer = server.turnSteer({
      threadId,
      expectedTurnId: "turn-0",
      input: text("stale"),
    });

    await expect(steer).rejects.toBeInstanceOf(CodexSteerPreconditionError);
  });

  it("declines server requests it has no policy for instead of leaving Codex waiting", async () => {
    const log = await logFile();
    const { server } = await start("--ask-approval", "--log", log);
    const { threadId } = await server.threadStart();

    await server.turnStart({ threadId, input: text("run something") });
    // Each round trip orders stdin: the second resume is written after the decline, so the log holds it.
    await server.threadResume(threadId);
    await server.threadResume(threadId);

    expect(await received(log)).toContainEqual(
      expect.objectContaining({
        id: "srv-1",
        error: expect.objectContaining({ code: -32601 }),
      }),
    );
  });

  it("rejects pending calls and emits exit with the code when the child exits", async () => {
    const { server, events } = await start("--exit-on", "turn/start", "--exit-code", "7");
    const { threadId } = await server.threadStart();

    const turn = server.turnStart({ threadId, input: text("crash") });

    await expect(turn).rejects.toBeInstanceOf(CodexAppServerExitedError);
    expect(await server.exited).toEqual({ exitCode: 7, signal: null });
    expect(events.at(-1)).toMatchObject({ kind: "exit", exitCode: 7 });
    await expect(server.threadResume(threadId)).rejects.toBeInstanceOf(CodexAppServerExitedError);
  });

  it("rejects startup when the executable cannot be spawned", async () => {
    const startup = startCodexAppServer({
      executablePath: "/nonexistent/codex",
      cwd: tmpdir(),
      env: {},
    });

    await expect(startup).rejects.toBeInstanceOf(CodexAppServerExitedError);
  });
});
