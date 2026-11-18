import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invokeCommand } from "@titan-design/registry";
import { openDatabase } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import type { ActiveWork, ReadName, ReadResult } from "./active-work.js";
import { cachedActiveWork } from "./active-work-cache.js";
import { brokerReader } from "./broker.js";
import { consoleCommands, warmCards, type ConsoleSources } from "./commands.js";
import { inboxReadCache } from "./inbox-rows.js";
import { keepWarm } from "./keep-warm.js";
import type { ConsoleContext } from "./owner-guard.js";
import type { ShepherdSource } from "./shepherd.js";
import type { FinishedRow } from "./shipped.js";

const REPO = "example-org/repo";
const local = (time: string): number => new Date(`2031-03-0${time}`).getTime();
const NO_AGENTS = { broker: brokerReader({ port: 1, tokenPath: "/nonexistent/ui.token" }), eventsDbPath: "/nonexistent/events.db", seatPrefixes: [] };
const LOOPBACK: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: null, ownerWrites: true };

const merged = (pr: number): FinishedRow => ({
  repo: REPO, pr, branch: `feat/f${pr}`, runId: `run-${pr}`, task: `example/EX-${pr}`, phase: "done", headSha: "a1b2c3d",
  phaseSince: new Date(local("5T12:00:00")).toISOString(), nextAction: "none", pendingGate: null, held: null, stalled: null, outcome: { kind: "merged" },
});
const RUNS = [merged(1), merged(2)];
const LANDED = { kind: "step", stepId: "sh-landed", completedAt: new Date(local("5T11:30:00")).toISOString() };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-coord-cards-first-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function seedSpawns(file: string): void {
  const db = openDatabase(file);
  db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)");
  const insert = db.prepare("INSERT INTO events (ts, kind, actor, target, meta) VALUES (?, ?, ?, ?, ?)");
  for (const { branch, task } of RUNS) insert.run(local("5T08:00:00"), "agent_spawned", "coord-a", `impl-${branch}`, JSON.stringify({ name: `impl-${branch}`, repo: REPO, branch, task, work_role: "implementer" }));
  db.close();
}

/** Upstreams that answer until `hang` is set, then never: a read still waiting on one after the prime never returns. */
function upstreams() {
  const state = { hang: false, timelines: 0, titleReads: 0 };
  function hangOr<T>(value: T): Promise<T> {
    return state.hang ? new Promise<T>(() => undefined) : Promise.resolve(value);
  }
  const shepherd = partialFake<ShepherdSource>({
    list: (which) => Promise.resolve(which === "finished" ? RUNS : []),
    timeline: () => ((state.timelines += 1), hangOr({ row: RUNS[0]!, entries: [LANDED] })),
  });
  function read<K extends ReadName>(command: K, args?: Record<string, unknown>): Promise<ReadResult<K>>;
  function read(): Promise<unknown> {
    state.titleReads += 1;
    return hangOr({ tasks: RUNS.map(({ task }) => ({ slug: "example", id: task.slice(8), title: `Title ${task.slice(8)}`, priority: 1, status: "open", updated: "2031-03-05" })) });
  }
  const inner: ActiveWork = { read };
  return { state, shepherd, activeWork: cachedActiveWork(inner) };
}

function sourcesOver({ shepherd, activeWork }: ReturnType<typeof upstreams>): ConsoleSources & Required<Pick<ConsoleSources, "inboxCache">> {
  const eventsDbPath = path.join(dir, "events.db");
  const coordinator = { roots: undefined, dayStart: "07:00", now: () => local("5T20:00:00"), cards: { shepherd, activeWork, eventsDbPath } };
  const base = { upstreams: [], agents: NO_AGENTS, sessions: { graphPath: "/nonexistent/graph.sqlite3" }, inbox: { dir: path.join(dir, "inbox") }, rounds: { dir: path.join(dir, "rounds") }, shepherd, activeWork, coordinator };
  return { ...base, inboxCache: inboxReadCache(base) };
}

describe("coord.cards' first read after a restart", () => {
  it("waits on no timeline or titles read once the primer read the cards", async () => {
    seedSpawns(path.join(dir, "events.db"));
    const world = upstreams();
    const sources = sourcesOver(world);
    await warmCards(sources);
    world.state.hang = true;

    const { envelope } = await invokeCommand(consoleCommands(sources)["coord.cards"]!, {}, LOOPBACK);

    expect(envelope).toMatchObject({ ok: true, data: { cards: [{ coordinator: "coord-a", tasks: [{ id: "EX-1", title: "Title EX-1" }, { id: "EX-2", title: "Title EX-2" }] }] } });
    expect(world.state).toMatchObject({ timelines: 2, titleReads: 1 });
  }, 3_000);

  it("is primed at serve start and on a factory reconnect, never on an active-work one", async () => {
    const { shepherd, activeWork } = upstreams();
    const inbox = { finished: { read: () => Promise.resolve([]) }, strips: { warm: () => Promise.resolve() }, shown: () => Promise.resolve() };
    let cardReads = 0;
    const warm = keepWarm({ activeWork, inbox, shepherd, cards: () => Promise.resolve(void (cardReads += 1)), logger: { warn: () => undefined } });

    await warm.prime();
    await warm.reconnected("factory");
    await warm.reconnected("active-work");

    expect(cardReads).toBe(2);
  });
});
