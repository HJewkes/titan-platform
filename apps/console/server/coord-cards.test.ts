import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@titan-design/store-sqlite";
import type { ActiveWork, ReadName, ReadResult } from "./active-work.js";
import { EVENTS_DB_UNREADABLE, readCards, type CardsSource } from "./coord-cards.js";
import type { FinishedRow } from "./shipped.js";

const REPO = "example-org/repo";
const local = (time: string): number => new Date(`2031-03-0${time}`).getTime();

interface Row {
  kind: string;
  actor: string;
  target?: string;
  at: string;
  meta?: Record<string, string> | string;
}

const spawn = (by: string, name: string, at: string, meta: Record<string, string> = {}): Row => ({
  kind: "agent_spawned", actor: by, target: name, at, meta: { name, repo: REPO, work_role: "implementer", ...meta },
});

function seedEvents(file: string, rows: readonly Row[]): void {
  const db = openDatabase(file);
  db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)");
  const insert = db.prepare("INSERT INTO events (ts, kind, actor, target, meta) VALUES (?, ?, ?, ?, ?)");
  for (const row of rows) insert.run(local(row.at), row.kind, row.actor, row.target ?? null, typeof row.meta === "string" ? row.meta : JSON.stringify(row.meta ?? {}));
  db.close();
}

function merged(pr: number, branch: string, task: string, since = "5T12:00:00"): FinishedRow {
  return {
    repo: REPO, pr, branch, runId: `run-${pr}`, task: `example/${task}`, phase: "done", headSha: "a1b2c3d", phaseSince: new Date(local(since)).toISOString(),
    nextAction: "none", pendingGate: null, held: null, stalled: null, outcome: { kind: "merged" },
  };
}

/** Answers every read with one titled task, or rejects every read, as a daemon that is down would. */
function fakeActiveWork(answer: () => Promise<unknown>): ActiveWork {
  function read<K extends ReadName>(command: K, args?: Record<string, unknown>): Promise<ReadResult<K>>;
  function read(): Promise<unknown> {
    return answer();
  }
  return { read };
}

const titled = fakeActiveWork(() => Promise.resolve({ tasks: [{ slug: "example", id: "EX-1", title: "First task", priority: 1, status: "open", updated: "2031-03-05" }] }));
const failing = fakeActiveWork(() => Promise.reject(new Error("daemon down")));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-coord-cards-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function source(rows: FinishedRow[], activeWork: ActiveWork = titled): CardsSource & { calls: string[] } {
  const calls: string[] = [];
  return { calls, activeWork, eventsDbPath: path.join(dir, "events.db"), shepherd: { list: async (state) => (calls.push(state), rows) } };
}

const read = (cards: CardsSource, autonomyDir: string | null = null) =>
  readCards(cards, { roots: { autonomyDir, agentChatDir: dir }, dayStart: "07:00", now: local("6T09:00:00"), date: "2031-03-05" });

describe("coord.cards attribution", () => {
  it("gives two coordinators a card each and leaves the PR no agent matches unattributed", async () => {
    seedEvents(path.join(dir, "events.db"), [
      spawn("coord-a", "impl-1", "5T08:00:00", { branch: "feat/one", task: "EX-1" }),
      spawn("coord-a", "impl-2", "5T09:00:00", { branch: "feat/two", task: "EX-2" }),
      spawn("coord-b", "impl-3", "5T10:00:00", { branch: "feat/three", task: "EX-3" }),
    ]);

    const result = await read(source([merged(1, "feat/one", "EX-1"), merged(2, "feat/elsewhere", "EX-9")]));

    expect(result.cards.map((card) => [card.coordinator, card.agentsRun, card.prsMerged.map((pr) => pr.number)])).toEqual([
      ["coord-a", 2, [1]],
      ["coord-b", 1, []],
    ]);
    expect(result.unattributed.map((pr) => pr.number)).toEqual([2]);
    expect(result.cards[0]!.tasks).toEqual([{ id: "EX-1", title: "First task" }, { id: "EX-2" }]);
  });

  it("leaves a PR unattributed when two coordinators' implementers carried its task", async () => {
    seedEvents(path.join(dir, "events.db"), [spawn("coord-a", "impl-1", "5T08:00:00", { task: "EX-1" }), spawn("coord-b", "impl-2", "5T09:00:00", { task: "example/EX-1" })]);

    const result = await read(source([merged(1, "feat/unknown", "EX-1")]));

    expect(result.unattributed.map((pr) => pr.number)).toEqual([1]);
    expect(result.cards.flatMap((card) => card.prsMerged)).toEqual([]);
  });

  it("attributes a PR merged today to the coordinator that spawned its agent yesterday, without counting that agent today", async () => {
    seedEvents(path.join(dir, "events.db"), [spawn("coord-a", "impl-1", "4T20:00:00", { branch: "feat/one" })]);

    const result = await read(source([merged(1, "feat/one", "EX-1")]));

    expect(result.cards).toMatchObject([{ coordinator: "coord-a", agentsRun: 0, prsMerged: [{ number: 1 }] }]);
  });
});

describe("coord.cards enrichment and failures", () => {
  it("keeps every card with task ids and no titles when the active-work read rejects", async () => {
    seedEvents(path.join(dir, "events.db"), [spawn("coord-a", "impl-1", "5T08:00:00", { branch: "feat/one", task: "EX-1" })]);

    const result = await read(source([merged(1, "feat/one", "EX-1")], failing));

    expect(result.cards).toMatchObject([{ coordinator: "coord-a", tasks: [{ id: "EX-1" }] }]);
    expect(result.cards[0]!.tasks[0]).not.toHaveProperty("title");
    expect(result.gaps).toEqual([expect.stringContaining("daemon down")]);
  });

  it("counts live agents and sums exit costs, and tags a coordinator whose name has a seat file", async () => {
    const autonomy = path.join(dir, "autonomy");
    await mkdir(path.join(autonomy, "seats"), { recursive: true });
    await writeFile(path.join(autonomy, "seats", "coord-a.md"), "---\n---\n");
    seedEvents(path.join(dir, "events.db"), [
      spawn("coord-a", "impl-1", "5T08:00:00"),
      spawn("coord-a", "impl-2", "5T08:30:00"),
      { kind: "agent_exited", actor: "impl-1", at: "5T09:00:00", meta: { code: "0", cost_usd: "1.25" } },
      { kind: "agent_retired", actor: "coord-a", target: "impl-2", at: "5T09:30:00" },
      { kind: "agent_resumed", actor: "coord-a", target: "impl-2", at: "5T10:00:00" },
    ]);

    const result = await read(source([]), autonomy);

    expect(result.cards).toMatchObject([{ coordinator: "coord-a", seat: "coord-a", agentsRun: 2, liveNow: 1, costUsd: 1.25 }]);
  });

  it("answers with a gap and every PR unattributed when events.db is absent, reading only Shepherd's finished list", async () => {
    const cards = source([merged(1, "feat/one", "EX-1")]);

    const result = await read(cards);

    expect(result).toMatchObject({ date: "2031-03-05", cards: [], gaps: [EVENTS_DB_UNREADABLE] });
    expect(result.unattributed.map((pr) => pr.number)).toEqual([1]);
    expect(cards.calls).toEqual(["finished"]);
  });
});
