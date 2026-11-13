import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EXIT, runCli } from "../cli.js";
import type { CliDeps } from "../cli-types.js";

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

async function eligible(args: string[], fetch: typeof globalThis.fetch) {
  const out = { stdout: "", stderr: "" };
  const io = { stdout: (t: string) => void (out.stdout += t), stderr: (t: string) => void (out.stderr += t), env: {} };
  const deps: CliDeps = { workflows: [], routes: [], fetch };
  const code = await runCli(["dispatch", "eligible", "--initiative", "alpha", ...args], io, deps);
  return { code, ...out };
}

describe("dispatch eligible", () => {
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

  it("--tag narrows the candidates to one lane", async () => {
    const rpc = fakeRpc({ tasks: [row(1, { tags: ["console"] }), row(2)], bets: [] });

    const { stdout } = await eligible(["--week", "2026-W47", "--tag", "console"], rpc.fetch);

    expect(stdout).toBe("week 2026-W47: 0 eligible, 1 refused (bet-not-selected=1)\nrefused AL-1 bet-not-selected\n");
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
});
