import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import type { ConsoleConfig } from "./config.js";
import { startConsoleDaemon } from "./daemon.js";
import type { InboxView } from "./inbox-view.js";
import { createRoundListeners } from "./listeners.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { fileRound } from "./round-file.js";
import type { SeatNotifier } from "./round-notice-transport.js";
import { send, startFakeBroker, startFakeDaemon, type FakeBroker, type FakeDaemon, type RpcAnswer } from "./test-support.js";

const TOKEN = "synthetic-token";

let dir: string;
let factory: FakeDaemon | undefined;
let broker: FakeBroker;
let handle: DaemonHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-inbox-view-notice-"));
  await writeFile(path.join(dir, "ui.token"), TOKEN, { mode: 0o600 });
  broker = await startFakeBroker({ token: TOKEN, sessions: [], items: [] });
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await factory?.close();
  factory = undefined;
  await broker.close();
  await rm(dir, { recursive: true, force: true });
});

function config(factoryPort: number): ConsoleConfig {
  return {
    port: 0,
    stateDir: path.join(dir, "state"),
    activeWorkPort: 1,
    agentChatPort: broker.port,
    factoryPort,
    agentChatTokenPath: path.join(dir, "ui.token"),
    agentChatEventsDbPath: path.join(dir, "events.db"),
    seatPrefixes: [],
    sessionGraphPath: path.join(dir, "graph.sqlite3"),
    codewatchUrl: "http://codewatch.test:7433",
    lanHost: null,
    lanNames: [],
    lanTls: null,
    lanTokenPath: path.join(dir, "state", "lan.token"),
    ownerWrites: false,
    gateAnswers: false,
    inboxDir: path.join(dir, "state", "inbox", "deposits"),
    roundsDir: path.join(dir, "state", "rounds"),
    decisionsFile: null,
  };
}

const okEnvelope = z.object({ ok: z.literal(true), data: z.custom<InboxView>() });

async function listInbox(factoryPort: number): Promise<InboxView> {
  handle = await startConsoleDaemon({ config: config(factoryPort), logger: silentLogger });
  const reply = await send("127.0.0.1", handle.port, "POST", "/rpc/inbox.list", { host: `127.0.0.1:${handle.port}`, "content-type": "application/json", "x-titan-client": "test" }, "{}");
  return okEnvelope.parse(JSON.parse(reply.body)).data;
}

async function serveFactory(rpc: RpcAnswer): Promise<number> {
  factory = await startFakeDaemon({ ok: true }, rpc);
  return factory.port;
}

describe("inbox.list's machine-derived rows", () => {
  describe("a round notice the start-up sweep could not send", () => {
    // Synthetic: a questions-only fixture round filed by a made-up seat and answered, in the temp state dir.
    const ROUND = "kiln-schedule-r2";
    const SEAT = "sample-seat";
    const roundsDir = (): string => path.join(dir, "state", "rounds");
    const isNoticeGap = (gap: string): boolean => gap.startsWith("round notices:");
    const noShepherd: RpcAnswer = (command) => (command === "needs.list" ? { items: [], gaps: [] } : []);

    async function fileAnsweredRound(): Promise<void> {
      const body = await readFile(path.join(FIXTURE_ROUNDS.dir, ROUND, "round.json"), "utf8");
      await fileRound({ body, roundsDir: roundsDir(), asker: { seat: SEAT, initiative: null } });
      await writeFile(path.join(roundsDir(), ROUND, "feedback.json"), "{}\n");
    }

    function sweep(notify: SeatNotifier): Promise<void> {
      const unused = () => Promise.reject(new Error("no factory in this test"));
      return createRoundListeners({ enabled: false, roundsDir: roundsDir(), shepherd: { list: unused }, answer: { post: unused }, notify, now: () => new Date() }).sweep();
    }

    async function listAgain(factoryPort: number): Promise<InboxView> {
      await handle?.close();
      return listInbox(factoryPort);
    }

    it("lists a missed-notice row linking the round until a later sweep reaches the seat", async () => {
      await fileAnsweredRound();
      await sweep(() => Promise.reject(new Error("seat sample-seat is not live")));
      const factoryPort = await serveFactory(noShepherd);

      const missed = await listInbox(factoryPort);
      await sweep(async () => undefined);
      const reached = await listAgain(factoryPort);

      expect(missed.gaps.filter(isNoticeGap)).toEqual([]);
      expect(missed.derived.map((each) => [each.kind, each.link])).toEqual([["missed-notice", `#/rounds/${ROUND}`]]);
      expect(missed.derived[0]).toMatchObject({ evidence: { observed: "notice failed after the start-up sweep's retry: seat sample-seat is not live", source: `round notice ${ROUND} to ${SEAT}` } });
      expect(reached.derived).toEqual([]);
    });

    it("names an unreadable rounds dir as a round notices gap", async () => {
      await mkdir(path.dirname(roundsDir()), { recursive: true });
      await writeFile(roundsDir(), "not a directory\n");

      const list = await listInbox(await serveFactory(noShepherd));

      expect(list.gaps.filter(isNoticeGap)).toHaveLength(1);
      expect(list.derived).toEqual([]);
    });
  });
});
