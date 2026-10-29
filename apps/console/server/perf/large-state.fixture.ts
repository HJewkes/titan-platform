/**
 * The synthetic large-state fixture the console's per-RPC budgets run against (TP-4403 §3d, d1). One seed gives the same
 * bytes on every build: a rounds dir and a deposit spool on disk, and fake active-work, factory and agent-chat daemons on
 * loopback that answer from memory. Each fake counts the calls it gets per command, so a budget can bound an RPC's
 * upstream calls without timing noise. Everything is synthetic.
 */
import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConsoleConfig } from "../config.js";
import { startFakeBroker, startFakeDaemon, type FakeBroker, type RpcAnswer } from "../test-support.js";
import { activeWorkAnswer } from "./active-work-answer.fixture.js";
import { activeWorkState, type ActiveWorkState } from "./active-work.fixture.js";
import { brokerHistoryItems, brokerQueueItems, brokerState, type BrokerState } from "./broker.fixture.js";
import { writeEventsDb, writeRounds, writeSpool } from "./disk.fixture.js";
import { FIXTURE_EPOCH_MS } from "./random.fixture.js";
import { factoryAnswer, factoryState, type FactoryState } from "./factory.fixture.js";

export const DEFAULT_PERF_SEED = "titan-console-perf-1";

const BROKER_TOKEN = "perf-fixture-token";

/** Upstream calls since the last reset, keyed `<upstream> <command or route>`: `active-work task.list`, `broker /api/history`. */
export interface UpstreamCalls {
  counts(): Record<string, number>;
  total(): number;
  reset(): void;
}

export interface PerfState {
  activeWork: ActiveWorkState;
  factory: FactoryState;
  broker: BrokerState;
}

export interface PerfFixture {
  config: ConsoleConfig;
  state: PerfState;
  calls: UpstreamCalls;
  close(): Promise<void>;
}

/** The generated data alone, with no file written and no port opened. */
export function perfState(seed: string = DEFAULT_PERF_SEED): PerfState {
  return { activeWork: activeWorkState(seed), factory: factoryState(seed), broker: brokerState(seed) };
}

function counted(upstream: string, answer: RpcAnswer, tally: Map<string, number>): RpcAnswer {
  return (command, args) => {
    const key = `${upstream} ${command}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    return answer(command, args);
  };
}

function upstreamCalls(tally: Map<string, number>, broker: FakeBroker): UpstreamCalls {
  const counts = (): Record<string, number> => {
    const all = new Map(tally);
    for (const request of broker.requests) {
      const key = `broker ${request.split(" ")[1]!.split("?")[0]}`;
      all.set(key, (all.get(key) ?? 0) + 1);
    }
    return Object.fromEntries([...all].sort(([a], [b]) => a.localeCompare(b)));
  };
  return {
    counts,
    total: () => Object.values(counts()).reduce((sum, each) => sum + each, 0),
    reset: () => {
      tally.clear();
      broker.requests.length = 0;
    },
  };
}

function configOf(dir: string, ports: { activeWork: number; agentChat: number; factory: number }): ConsoleConfig {
  const stateDir = path.join(dir, "state");
  return {
    port: 0,
    stateDir,
    activeWorkPort: ports.activeWork,
    agentChatPort: ports.agentChat,
    factoryPort: ports.factory,
    agentChatTokenPath: path.join(dir, "ui.token"),
    agentChatEventsDbPath: path.join(dir, "events.db"),
    seatPrefixes: [],
    sessionGraphPath: path.join(dir, "graph.sqlite3"),
    codewatchUrl: "http://codewatch.test:7433",
    lanHost: null,
    lanNames: [],
    lanTls: null,
    lanTokenPath: path.join(stateDir, "lan.token"),
    ownerWrites: false,
    gateAnswers: false,
    inboxDir: path.join(stateDir, "inbox", "deposits"),
    roundsDir: path.join(stateDir, "rounds"),
    decisionsFile: null,
  };
}

async function writeDiskState(seed: string, dir: string, state: PerfState): Promise<void> {
  const tokenPath = path.join(dir, "ui.token");
  await mkdir(path.join(dir, "state", "rounds"), { recursive: true });
  await writeFile(tokenPath, BROKER_TOKEN, { mode: 0o600 });
  await utimes(tokenPath, FIXTURE_EPOCH_MS / 1000, FIXTURE_EPOCH_MS / 1000);
  await writeRounds(seed, path.join(dir, "state", "rounds"));
  await writeSpool(seed, path.join(dir, "state", "inbox", "deposits"));
  writeEventsDb(path.join(dir, "events.db"), state.broker);
}

/** Writes the fixture into `dir`, which must be empty, and starts its fakes; `close` stops them and leaves `dir` to the caller. */
export async function buildPerfFixture(dir: string, seed: string = DEFAULT_PERF_SEED): Promise<PerfFixture> {
  const state = perfState(seed);
  await writeDiskState(seed, dir, state);
  const tally = new Map<string, number>();
  const activeWork = await startFakeDaemon({ ok: true, index: {} }, counted("active-work", activeWorkAnswer(state.activeWork), tally));
  const factory = await startFakeDaemon({ ok: true }, counted("factory", factoryAnswer(state.factory), tally));
  const broker = await startFakeBroker({ token: BROKER_TOKEN, sessions: state.broker.sessions, items: brokerHistoryItems(state.broker), queue: brokerQueueItems(state.broker) });
  return {
    config: configOf(dir, { activeWork: activeWork.port, agentChat: broker.port, factory: factory.port }),
    state,
    calls: upstreamCalls(tally, broker),
    close: async () => {
      await Promise.all([activeWork.close(), factory.close(), broker.close()]);
    },
  };
}
