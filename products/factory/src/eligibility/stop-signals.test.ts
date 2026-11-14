import type * as Fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SCORECARD_MIGRATIONS, upsertTaskRows, type TaskRow } from "@titan-design/session-analytics";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import type { StepResult } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Verbs } from "../cli-types.js";
import { stackFrozen } from "../shepherd/stack-cascade.js";
import type { LoadedRules } from "./shadow/rule-file.js";
import type { RefusedRow } from "./shadow/row.js";
import { shadowTick } from "./shadow/tick.js";
import { calm, enabledRules, fakeRpc, readRows, selectedBet, shadowHome, shadowTickCli, task } from "./shadow/tick.test-helpers.js";
import * as stopSignals from "./stop-signals.js";
import { fixRoundsOf, readScorecardSpend, readStopMarks, stopProvider, type StopSignalRead } from "./stop-signals.js";

const fsCalls = vi.hoisted(() => ({ writes: [] as string[] }));

/** Records every fs call that could write, so a test can prove a tick leaves the stop marks alone. */
vi.mock("node:fs", async (original) => {
  const real = await original<typeof Fs>();
  const writes = /^(write|append|rename|copy|cp|rm|unlink|truncate|open|mkdir|symlink|link)/;
  const recorded = Object.fromEntries(
    Object.entries(real).map(([name, value]: [string, unknown]) => [
      name,
      typeof value === "function" && writes.test(name) ? (...args: unknown[]): unknown => (fsCalls.writes.push(`${name} ${String(args[0])}`), Reflect.apply(value, real, args)) : value,
    ]),
  );
  return { ...recorded, default: recorded };
});

const NOW = "2026-11-18T12:00:00Z";

afterEach(() => void vi.useRealTimers());

function newHead(round: number, result: Record<string, unknown>): StepResult {
  return { stepId: "sh-await-new-head", iteration: round, operation: "dispatch", agentId: null, signal: null, completedAt: "2026-11-05T00:00:00Z", data: { result } };
}

/** `rounds` pushed fix rounds among wakes that are not rounds: an exit with no push, a green head, a closed PR, another step. */
function runWith(rounds: number): { stepResults: Record<string, StepResult> } {
  const pushed = Array.from({ length: rounds }, (_, round) => newHead(round, { headSha: `sha-${round}`, state: "open" }));
  const other = [newHead(90, { state: "open", exited: true }), newHead(91, { state: "open", green: true }), newHead(92, { state: "closed" }), { ...newHead(93, { state: "open" }), stepId: "sh-ci-wait" }];
  return { stepResults: Object.fromEntries([...pushed, ...other].map((result) => [`${result.stepId}:${result.iteration}`, result])) };
}

describe("fixRoundsOf", () => {
  it("counts only pushed heads, and agrees with stack-cascade's freeze on the same runs", () => {
    const counted = [0, 1, 2, 3, 4].map((rounds) => fixRoundsOf(runWith(rounds)));

    expect(counted).toEqual([0, 1, 2, 3, 4]);
    expect([0, 1, 2, 3, 4].map((rounds) => stackFrozen(runWith(rounds)))).toEqual(counted.map((rounds) => rounds > 2));
  });
});

describe("readStopMarks", () => {
  it("an absent file reads as no marks and no checkpoints", () => {
    expect(readStopMarks(join(tmpdir(), "no-such-stops", "stops.json"))).toEqual({ plannerLooked: new Set(), checkpoints: new Map() });
    expect(readStopMarks(undefined).plannerLooked.size).toBe(0);
  });

  it("reads planner marks and checkpoint counts, and names the file when it does not parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "stops-"));
    writeFileSync(join(dir, "stops.json"), JSON.stringify({ planner_looked: ["alpha/AL-1"], checkpoints: { "alpha/B1": [5, 10] } }));
    writeFileSync(join(dir, "broken.json"), JSON.stringify({ checkpoints: { "alpha/B1": ["five"] } }));

    expect(readStopMarks(join(dir, "stops.json"))).toEqual({ plannerLooked: new Set(["alpha/AL-1"]), checkpoints: new Map([["alpha/B1", new Set([5, 10])]]) });
    expect(() => readStopMarks(join(dir, "broken.json"))).toThrow(/^state\/stops\.json: /);
  });
});

function scorecardRow(taskId: string, usd: number | null): TaskRow {
  const zero = { prs: 1, fixRounds: 0, reviewRounds: 0, ownerGates: 0, ownerGateHours: 0, dupPrs: 0 };
  const unmeasured = { dispatchRule: null, classAtDispatch: null, sourceAtDispatch: null, servesAtDispatch: null, rankAtDispatch: null, ageAtDispatchH: null, ruleRankPct: null, inRuleTopk: null };
  const outcome = { mergedAt: null, revertedBy: null, doneReason: null, followupsN: null, followupsEst: null, briefHasDoneWhen: null, leadCreatedDoneH: null, leadDispatchMergeH: null };
  return { initiative: "alpha", taskId, firstDispatchTs: "2026-11-02T00:00:00Z", dispatcher: "seat-a", ...unmeasured, ...outcome, ...zero, usd, usdLink: null, provenance: {}, inputsHash: "h" };
}

describe("readScorecardSpend", () => {
  it("no store reads as unread", () => {
    expect(readScorecardSpend({ TITAN_SCORECARD_STORE: join(tmpdir(), "no-such-scorecard", "scorecard.sqlite3") })).toEqual({ ok: false, why: "no ticket-scorecard store" });
  });

  it("reads each task row's usd from the store, read-only", () => {
    const file = join(mkdtempSync(join(tmpdir(), "scorecard-")), "scorecard.sqlite3");
    const db = openDatabase(file);
    runMigrations(db, SCORECARD_MIGRATIONS);
    upsertTaskRows(db, [scorecardRow("AL-1", 12.5), scorecardRow("AL-2", null)], "2026-11-10T00:00:00Z");
    db.close();

    expect(readScorecardSpend({ TITAN_SCORECARD_STORE: file })).toEqual({ ok: true, usd: new Map([["alpha/AL-1", 12.5], ["alpha/AL-2", null]]) });
  });
});

describe("stop rows in a shadow tick", () => {
  const verbs = (fetch: typeof globalThis.fetch, env: NodeJS.ProcessEnv) => partialFake<Verbs>({ io: { stdout: () => {}, stderr: () => {}, env }, deps: { workflows: [], routes: [], fetch, laneSignals: async () => calm } });

  /** A shadow dir under `root`, with `marks` written to `<root>/state/stops.json`. */
  function stopHome(marks: object): { loaded: LoadedRules; stopsFile: string } {
    const root = mkdtempSync(join(tmpdir(), "stop-home-"));
    mkdirSync(join(root, "state"));
    const stopsFile = join(root, "state", "stops.json");
    writeFileSync(stopsFile, JSON.stringify(marks));
    const stop = { taskFixRounds: 3, spendMultiple: 2, usdPerPoint: 8, betStoppedPrs: 3, betFollowupMultiple: 2, checkpointEvery: 5 };
    const upkeep = { capShare: 0.25, windowDays: 7, factoryOutcomes: [] };
    return { loaded: { rules: { schema: "titan-dispatcher/v1", mode: "shadow", shadow: { enabled: true, dir: join(root, "shadow") }, lanes: [{ initiative: "alpha", tag: "lane-a" }], stop, upkeep }, hash: "sha256:0" }, stopsFile };
  }

  it("a tick reads the marks file and never writes it, and the module exports no writer", async () => {
    const { loaded, stopsFile } = stopHome({ planner_looked: ["alpha/AL-1"] });
    const before = readFileSync(stopsFile, "utf8");
    const stopped = (n: number) => ({ task: `alpha/AL-${n}`, pr: `acme/app#${n}`, createdAt: "2026-11-10T00:00:00Z", outcome: "stopped" as const, fixRounds: n === 1 ? 3 : 0 });
    const read: StopSignalRead = async (query) => ({ tasks: [], runs: [1, 2, 3].map(stopped), spend: { ok: false, why: "no ticket-scorecard store" }, marks: readStopMarks(query.marksFile) });
    const rpc = fakeRpc({ tasks: [task(1), task(2)], bets: [selectedBet(1, 1, ["alpha/AL-1", "alpha/AL-2", "alpha/AL-3"])] });
    fsCalls.writes.length = 0;

    const { rows } = await shadowTick({ loaded, verbs: verbs(rpc.fetch, {}), now: new Date(NOW), wake: "w", providers: [stopProvider(read)] });

    const held = rows.filter((row): row is RefusedRow => row.kind === "refused" && row.stage === "stop");
    expect(held.map((row) => [row.task, row.codes, row.next, row.would_ask, row.numbers])).toEqual([
      ["alpha/AL-1", ["task-fix-cap", "bet-parked"], "park", true, { fixRounds: 3, cap: 3, stoppedPrs: 3 }],
      ["alpha/AL-2", ["bet-parked"], undefined, true, { stoppedPrs: 3 }],
    ]);
    expect(fsCalls.writes.filter((call) => call.includes(dirname(stopsFile)))).toEqual([]);
    expect(readFileSync(stopsFile, "utf8")).toBe(before);
    expect(Object.keys(stopSignals).filter((name) => /write|save|record|append|mark(?!s)/i.test(name))).toEqual([]);
  });

  it("a full enabled tick with no stops file creates none and holds nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(NOW) });
    const home = shadowHome();
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));
    const rpc = fakeRpc({ tasks: [task(1)], bets: [selectedBet(1, 1, ["alpha/AL-1"])] });

    await shadowTickCli(home, rpc.fetch);

    expect(readRows(home.shadowDir)[0]!.rows.map((row) => row.kind)).toEqual(["wake", "would-dispatch"]);
    expect(existsSync(join(home.dir, "state"))).toBe(false);
  });
});
