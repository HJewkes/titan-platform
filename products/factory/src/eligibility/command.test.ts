import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EXIT, runCli } from "../cli.js";
import type { CliDeps } from "../cli-types.js";
import type { LaneScope, LaneSignals } from "./back-pressure.js";

type Body = Record<string, unknown>;

const prediction = { metric: "lead time", direction: "decrease", baseline: 4, expected: 2, read_by: "2026-11-30" };

function selectedBet(n: number, order: number, tasks: string[]) {
  return { id: `alpha/B${n}`, initiative: "alpha", week: "2026-W47", outcome: "alpha/faster-landing", order, tasks, prediction, state: "selected" };
}

function row(n: number, fields: Body = {}) {
  const base = { id: `AL-${n}`, title: `Synthetic ${n}`, priority: 1, status: "open", created: `2026-11-0${n}`, updated: "2026-11-09", done_at: null };
  return { ...base, done_when: "A test shows it.", bet: "alpha/B1", fold: "independent", owner_steps: [], slug: "alpha", ...fields };
}

function freeze(n: number, tag: string, end_condition: Body) {
  return { id: `alpha/F${n}`, initiative: "alpha", tag, reason: "Hold", end_condition, set_by: "owner", intent_ref: "D1", quote_ref: "msg:1" };
}

interface Workspace {
  tasks: Body[];
  done?: Body[];
  bets: Body[];
  freezes?: Body[];
}

/** An active-work daemon that answers only the read commands the reader may call, and records each one. */
function fakeRpc(ws: Workspace) {
  const calls: { command: string; body: Body }[] = [];
  const answer = (command: string, body: Body): unknown => {
    if (command === "task.list" && body.id !== undefined) return { tasks: (ws.done ?? []).filter((task) => task.id === body.id) };
    if (command === "task.list") return { tasks: ws.tasks.filter((task) => body.tag === undefined || (Array.isArray(task.tags) && task.tags.includes(body.tag))) };
    if (command === "plan.bet.list") return ws.bets.filter((bet) => bet.week === body.week);
    if (command === "plan.freeze.list") return ws.freezes ?? [];
    if (command === "plan.out-of-scope.list") return [];
    throw new Error(`unexpected ${command}`);
  };
  const fetch = (async (url, init) => {
    const command = String(url).split("/rpc/")[1]!;
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body)));
    calls.push({ command, body });
    return new Response(JSON.stringify({ ok: true, data: answer(command, body) }));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const calm: LaneSignals = { openPrs: 0, mergedNotDeployed: 0, ownerQueue: 0, reviewers: { accounts: 1, exhausted: 0 }, deployStall: [], redMain: [], unread: {} };

interface LaneOptions {
  signals?: Partial<LaneSignals>;
  env?: NodeJS.ProcessEnv;
  scopes?: LaneScope[];
}

async function eligible(args: string[], fetch: typeof globalThis.fetch, lane: LaneOptions = {}) {
  const out = { stdout: "", stderr: "" };
  const io = { stdout: (t: string) => void (out.stdout += t), stderr: (t: string) => void (out.stderr += t), env: lane.env ?? {} };
  const laneSignals = async (scope: LaneScope) => (lane.scopes?.push(scope), { ...calm, ...lane.signals });
  const deps: CliDeps = { workflows: [], routes: [], fetch, laneSignals };
  const code = await runCli(["dispatch", "eligible", "--initiative", "alpha", ...args], io, deps);
  return { code, ...out };
}

describe("dispatch eligible", () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-13T12:00:00Z") }));
  afterEach(() => void vi.useRealTimers());

  it("prints eligible tasks in bet order and refused tasks with their codes, calling only read commands", async () => {
    const rpc = fakeRpc({
      tasks: [row(1), row(2, { bet: "alpha/B2" }), row(3, { bet: undefined }), row(4, { done_when: undefined }), { id: "AL-5", status: "open" }],
      bets: [selectedBet(1, 2, ["alpha/AL-1", "alpha/AL-4"]), selectedBet(2, 1, ["alpha/AL-2"])],
    });

    const { code, stdout } = await eligible(["--week", "2026-W47", "--json"], rpc.fetch);

    expect(code).toBe(EXIT.OK);
    const report = JSON.parse(stdout);
    expect(report.eligible.map((entry: Body) => entry.id)).toEqual(["AL-2", "AL-1"]);
    expect(report.counts).toEqual({ eligible: 2, refused: 3, byCode: { "no-bet": 1, "no-done-when": 1, unreadable: 1 } });
    expect(new Set(rpc.calls.map((call) => call.command))).toEqual(new Set(["task.list", "plan.bet.list", "plan.freeze.list", "plan.out-of-scope.list"]));
    expect(rpc.calls.find((call) => call.command === "plan.bet.list")?.body).toEqual({ initiative: "alpha", week: "2026-W47", state: "selected" });
  });

  it("a freeze in force refuses its tagged task, while a freeze whose end task is done or whose date passed does not", async () => {
    const rpc = fakeRpc({
      tasks: [row(1, { tags: ["held"] }), row(2, { tags: ["released"] }), row(3, { tags: ["expired"] })],
      done: [{ id: "AL-9", status: "done" }],
      bets: [selectedBet(1, 1, ["alpha/AL-1", "alpha/AL-2", "alpha/AL-3"])],
      freezes: [freeze(1, "held", { kind: "owner" }), freeze(2, "released", { kind: "task-done", task: "alpha/AL-9" }), freeze(3, "expired", { kind: "date", date: "2020-01-01" })],
    });

    const { stdout } = await eligible(["--week", "2026-W47", "--json"], rpc.fetch);

    const report = JSON.parse(stdout);
    expect(report.refused).toEqual([{ id: "AL-1", refusals: [{ code: "frozen", detail: "under alpha/F1" }] }]);
    expect(report.eligible.map((entry: Body) => entry.id)).toEqual(["AL-2", "AL-3"]);
  });

  it("a freeze the owner has ended no longer refuses its tagged task", async () => {
    const rpc = fakeRpc({
      tasks: [row(1, { tags: ["held"] })],
      bets: [selectedBet(1, 1, ["alpha/AL-1"])],
      freezes: [{ ...freeze(1, "held", { kind: "owner" }), ended_on: "2026-11-10" }],
    });

    const { stdout } = await eligible(["--week", "2026-W47", "--json"], rpc.fetch);

    const report = JSON.parse(stdout);
    expect(report.refused).toEqual([]);
    expect(report.eligible.map((entry: Body) => entry.id)).toEqual(["AL-1"]);
  });

  it("--tag narrows the candidates to one lane", async () => {
    const rpc = fakeRpc({ tasks: [row(1, { tags: ["console"] }), row(2)], bets: [] });

    const { stdout } = await eligible(["--week", "2026-W47", "--tag", "console"], rpc.fetch);

    expect(stdout).toBe("lane alpha/console: admit; next none\nsignals openPrs=0 mergedNotDeployed=0 ownerQueue=0 reviewerAccounts=1 reviewersExhausted=0 deployCauses=0 redMainRepos=0 unread=none\nfiling open (2026-W44 in=1 out=0, 2026-W45 in=0 out=0)\nweek 2026-W47: 0 eligible, 1 refused (bet-not-selected=1)\nrefused AL-1 bet-not-selected\n");
  });

  it("a malformed --week is a usage error and reads nothing", async () => {
    const rpc = fakeRpc({ tasks: [], bets: [] });

    const { code, stderr } = await eligible(["--week", "2026-47"], rpc.fetch);

    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain("ISO week");
    expect(rpc.calls).toEqual([]);
  });

  it("exits 69 when active-work is down", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const { code, stderr } = await eligible(["--week", "2026-W47"], down);

    expect(code).toBe(EXIT.UNAVAILABLE);
    expect(stderr).toContain("error:");
  });

  it("puts the lane's admission first, holding only the gate-creating task while the owner queue is over its limit", async () => {
    const rpc = fakeRpc({
      tasks: [row(1, { owner_steps: [{ kind: "release", note: "cut the release" }] }), row(2)],
      bets: [selectedBet(1, 1, ["alpha/AL-1", "alpha/AL-2"])],
    });

    const { code, stdout } = await eligible(["--week", "2026-W47", "--json"], rpc.fetch, { signals: { ownerQueue: 11 } });

    expect(code).toBe(EXIT.OK);
    const report = JSON.parse(stdout);
    expect(Object.keys(report)[0]).toBe("admission");
    expect(report.admission).toMatchObject({ decision: "admit", next: "AL-2", limits: { laneOpenPrs: 3, ownerQueue: 10, inflowWeeks: 2 } });
    expect(report.admission.holds).toEqual([expect.objectContaining({ code: "owner-queue", scope: "gate-creating", numbers: { items: 11, limit: 10 } })]);
    expect(report.eligible.map((entry: Body) => [entry.id, entry.held])).toEqual([
      ["AL-1", ["owner-queue"]],
      ["AL-2", []],
    ]);
  });

  it("a lane at its PR limit holds every task and names no next task", async () => {
    const rpc = fakeRpc({ tasks: [row(1)], bets: [selectedBet(1, 1, ["alpha/AL-1"])] });

    const { stdout } = await eligible(["--week", "2026-W47"], rpc.fetch, { signals: { openPrs: 2, mergedNotDeployed: 1 } });

    expect(stdout.split("\n").slice(0, 3)).toEqual([
      "lane alpha: hold (merged-not-deployed); next none",
      "signals openPrs=2 mergedNotDeployed=1 ownerQueue=0 reviewerAccounts=1 reviewersExhausted=0 deployCauses=0 redMainRepos=0 unread=none",
      "hold merged-not-deployed lane open=2 mergedNotDeployed=1 limit=3: 2 unmerged and 1 merged-not-deployed PR(s) at a limit of 3",
    ]);
    expect(stdout).toContain("eligible AL-1 alpha/B1 - 2026-11-01 held=merged-not-deployed\n");
  });

  it("reads the owner's limit from the factory config, and scopes the signals to the lane's tasks, done ones too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bp-config-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ shepherd: { backPressure: { laneOpenPrs: 4 } } }));
    const rpc = fakeRpc({ tasks: [row(1, { tags: ["console"] }), row(2, { tags: ["console"], status: "done" }), row(3)], bets: [] });
    const scopes: LaneScope[] = [];

    const { stdout } = await eligible(["--week", "2026-W47", "--tag", "console", "--json"], rpc.fetch, { signals: { openPrs: 3 }, env: { TITAN_FACTORY_CONFIG: join(dir, "config.json") }, scopes });

    expect(JSON.parse(stdout).admission).toMatchObject({ decision: "admit", holds: [], limits: { laneOpenPrs: 4 } });
    expect(["alpha/AL-1", "alpha/AL-2", "alpha/AL-3"].map((key) => scopes[0]!.inLane(key))).toEqual([true, true, false]);
  });
});
