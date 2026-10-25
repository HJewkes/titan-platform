import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { SeatDigestPacingSchema, digestPacer } from "./seat-digest-pace.js";
import { sendSeatDigests, type DigestInput, type SeatDigestMemory, type SeatDigestPorts, type SeatState } from "./seat-digest.js";
import type { WatchRow } from "./view.js";
import { digestWatches, watchListMigration, watchListTable, type DigestWatches, type PrWatch, type WatchEvent } from "./watch-list.js";

const START = Date.parse("2026-10-10T00:00:00.000Z");
const MINUTE = 60_000;
const PACING = SeatDigestPacingSchema.parse({});

function row(n: number, extra: Partial<WatchRow> = {}): WatchRow {
  return { repo: "acme/widgets", pr: n, branch: `feat/${n}`, runId: `run-${n}`, task: `demo/T-${n}`, phase: "ci", headSha: "a".repeat(40), phaseSince: "2026-10-10T00:00:00.000Z", nextAction: "waiting for CI", pendingGate: null, held: null, stalled: null, outcome: null, ...extra };
}

function run(id: string, done = false): WorkflowRun {
  return { id, workflowName: "shepherd-pr", params: {}, status: done ? "completed" : "running", currentStep: done ? null : "ci-wait:0", stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: "2026-10-10T00:00:00.000Z", completedAt: null, error: null };
}

const idle: DigestInput = { row: row(100), run: run("run-100") };
const gated = (n: number): DigestInput => ({ row: row(n, { phase: "awaiting-approval", pendingGate: { gateId: `run-${n}/ci-failed`, stepId: "ci-failed", since: "2026-10-10T00:00:00.000Z" } }), run: run(`run-${n}`) });
const merged = (n: number): DigestInput => ({ row: row(n, { phase: "done", outcome: { kind: "merged", reason: null } }), run: run(`run-${n}`, true) });
const stopped = (n: number): DigestInput => ({ row: row(n, { phase: "done", outcome: { kind: "stopped", reason: "closed" } }), run: run(`run-${n}`, true) });
const failed = (n: number): DigestInput => ({ row: row(n, { phase: "failed" }), run: run(`run-${n}`, true) });

/** An in-memory watch list keyed by run id, standing in for the store's table. */
type TestWatches = DigestWatches & { left: () => string[]; add: (runId: string, on: WatchEvent[], seat: string) => void };

function watchList(entries: Record<string, WatchEvent[]>, seat: string | null = null): TestWatches {
  const watchOf = (runId: string, on: WatchEvent[], named: string | null): PrWatch => ({ repo: "acme/widgets", pr: Number(runId.slice(4)), seat: named, on, actor: "widgets-coord", at: "2026-10-10T00:00:00.000Z" });
  const watches = new Map(Object.entries(entries).map(([runId, on]): [string, PrWatch] => [runId, watchOf(runId, on, seat)]));
  return {
    of: (runId) => watches.get(runId),
    drop: (runIds) => runIds.forEach((runId) => watches.delete(runId)),
    left: () => [...watches.keys()],
    add: (runId, on, named) => void watches.set(runId, watchOf(runId, on, named)),
  };
}

/** Every run's own seat is widgets-coord; a watch naming a seat sends that seat a copy, as serve's live routing would. */
function harness(watches: DigestWatches, failFor: readonly string[] = []) {
  const sent: { at: number; seat: string; text: string }[] = [];
  const states = new Map<string, SeatState>();
  const memory: SeatDigestMemory = { get: (seat) => states.get(seat), set: (seat, state) => void states.set(seat, state) };
  const pacer = digestPacer(PACING);
  const ports = (at: number): SeatDigestPorts => ({
    seatLookup: () => () => "widgets-coord",
    send: async (seat, text) => {
      if (failFor.includes(seat)) throw new Error("broker down");
      sent.push({ at, seat, text });
    },
  });
  const routes = { seatOf: () => "widgets-coord", copyOf: (run: { runId: string }) => watches.of(run.runId)?.seat ?? undefined, watches };
  const sweep = (inputs: DigestInput[], at: number) => sendSeatDigests(inputs, ports(at), memory, { ...routes, unsendable: new Map() }, new Date(at), pacer);
  return { sent, sweep };
}

/** Sweeps once a minute from minute 0 to `last`, with `inputs` open throughout, after a first sweep that knows only `idle`. */
async function minutes(sweep: ReturnType<typeof harness>["sweep"], inputs: DigestInput[], last: number): Promise<void> {
  await sweep([idle], START - MINUTE);
  for (let m = 0; m <= last; m += 1) await sweep([idle, ...inputs], START + m * MINUTE);
}

describe("watched runs in the seat digest", () => {
  it("sends a watched run's merge once it settles, not at the 30-minute batch flush", async () => {
    const watches = watchList({ "run-1": ["merged", "stopped", "gated"] });
    const { sent, sweep } = harness(watches);

    await minutes(sweep, [merged(1)], 40);

    expect(sent.map((s) => s.at)).toEqual([START + 2 * MINUTE]);
    expect(sent[0]!.text).toContain("acme/widgets#1 merged");
  });

  it("carries an unwatched merge along on the digest a watched merge brings", async () => {
    const { sent, sweep } = harness(watchList({ "run-1": ["merged"] }));

    await minutes(sweep, [merged(1), merged(2)], 40);

    expect(sent.map((s) => s.at)).toEqual([START + 2 * MINUTE]);
    expect(sent[0]!.text).toContain("- acme/widgets#1 merged\n- acme/widgets#2 merged");
  });

  it("leaves a merge on the batch flush when the watch names only gated, and drops the watch once that flush tells it", async () => {
    const watches = watchList({ "run-1": ["gated"] });
    const { sent, sweep } = harness(watches);

    await minutes(sweep, [merged(1)], 29);
    const beforeFlush = watches.left();
    for (let m = 30; m <= 40; m += 1) await sweep([idle, merged(1)], START + m * MINUTE);

    expect(beforeFlush).toEqual(["run-1"]);
    expect(sent.map((s) => s.at)).toEqual([START + 30 * MINUTE]);
    expect(watches.left()).toEqual([]);
  });

  it("drops a watch on merged once the batch flush tells the run stopped", async () => {
    const watches = watchList({ "run-1": ["merged"] });
    const { sent, sweep } = harness(watches);

    await minutes(sweep, [stopped(1)], 40);

    expect(sent.map((s) => [s.at, s.text.includes("acme/widgets#1 stopped (closed)")])).toEqual([[START + 30 * MINUTE, true]]);
    expect(watches.left()).toEqual([]);
  });

  it("drops a watch whose run ended with no outcome to tell, sending nothing", async () => {
    const watches = watchList({ "run-1": ["merged", "stopped", "gated"] });
    const { sent, sweep } = harness(watches);

    await minutes(sweep, [failed(1)], 2);

    expect(sent).toEqual([]);
    expect(watches.left()).toEqual([]);
  });

  it("tells a watching seat with no digest memory yet a stop its watch did not name, then drops the watch", async () => {
    const watches = watchList({ "run-1": ["gated"] });
    const { sent, sweep } = harness(watches);

    for (let m = 0; m <= 40; m += 1) await sweep([stopped(1)], START + m * MINUTE);

    expect(sent.map((s) => s.text.includes("acme/widgets#1 stopped"))).toEqual([true]);
    expect(watches.left()).toEqual([]);
  });

  it("keeps the watch while the digest is held, and drops it once the digest that reports the merge is sent", async () => {
    const watches = watchList({ "run-1": ["merged"] });
    const { sweep } = harness(watches);
    await sweep([idle], START - MINUTE);

    await sweep([idle, merged(1)], START + MINUTE);
    const whileHeld = watches.left();
    await sweep([idle, merged(1)], START + 3 * MINUTE);

    expect(whileHeld).toEqual(["run-1"]);
    expect(watches.left()).toEqual([]);
  });

  it("keeps the watch when the digest could not be sent, so the next sweep reports the merge again", async () => {
    const watches = watchList({ "run-1": ["merged"] });
    const { sweep } = harness(watches, ["widgets-coord"]);

    await minutes(sweep, [merged(1)], 5);

    expect(watches.left()).toEqual(["run-1"]);
  });

  it("tells a watching seat with no digest memory yet the merge, and drops the watch only after that send", async () => {
    const watches = watchList({ "run-1": ["merged"] });
    const { sent, sweep } = harness(watches);

    await sweep([merged(1)], START);
    const beforeSend = watches.left();
    await sweep([merged(1)], START + 2 * MINUTE);

    expect(beforeSend).toEqual(["run-1"]);
    expect(sent.map((s) => [s.at, s.seat, s.text.includes("acme/widgets#1 merged")])).toEqual([[START + 2 * MINUTE, "widgets-coord", true]]);
    expect(watches.left()).toEqual([]);
  });

  it("sends --seat a copy of the run's gate while the run's own seat keeps it and is never told it cleared", async () => {
    const watches = watchList({});
    const { sent, sweep } = harness(watches);
    await minutes(sweep, [gated(1)], 3);
    watches.add("run-1", ["gated", "merged"], "ops-coord");

    for (let m = 4; m <= 40; m += 1) await sweep([idle, gated(1)], START + m * MINUTE);

    expect(sent.filter((s) => s.seat === "widgets-coord").map((s) => s.text).join("\n")).not.toContain("Cleared");
    expect(sent.filter((s) => s.seat === "ops-coord").map((s) => [s.at, s.text.includes("acme/widgets#1 waits on ci-failed")])).toEqual([[START + 6 * MINUTE, true]]);
  });

  it("keeps a --seat watch when only the run's own seat was told the merge", async () => {
    const watches = watchList({ "run-1": ["merged"] }, "ops-coord");
    const { sent, sweep } = harness(watches, ["ops-coord"]);

    await minutes(sweep, [merged(1)], 40);

    expect(sent.map((s) => s.seat)).toEqual(["widgets-coord"]);
    expect(watches.left()).toEqual(["run-1"]);
  });
});

describe("watch list table", () => {
  it("follows the PR's current run, and a drop clears the stored watch", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [watchListMigration(41)]);
    const table = watchListTable(db, () => "2026-10-10T00:00:00.000Z");
    table.set({ repo: "Acme/Widgets", pr: 1, seat: null, on: ["merged"], actor: "widgets-coord" });
    const current = { runId: "run-1b" };
    const watches = digestWatches({ watches: () => table, byPr: (repo, pr) => (repo === "acme/widgets" && pr === 1 ? current : undefined) });

    const followed = [watches.of("run-1"), watches.of("run-1b")?.pr];
    watches.drop(["run-1b"]);

    expect(followed).toEqual([undefined, 1]);
    expect(table.list()).toEqual([]);
  });

  it("skips a stored watch whose events cannot be read, so one bad row never stops the sweep", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [watchListMigration(41)]);
    const table = watchListTable(db, () => "2026-10-10T00:00:00.000Z");
    table.set({ repo: "acme/widgets", pr: 1, seat: null, on: ["merged"], actor: "widgets-coord" });
    db.prepare("INSERT INTO shepherd_watch (repo, pr, seat, events, actor, at) VALUES (?, ?, ?, ?, ?, ?)").run("acme/widgets", 2, null, "not json", "x", "2026-10-10T00:00:00.000Z");

    expect(table.list().map((watch) => watch.pr)).toEqual([1]);
  });
});
