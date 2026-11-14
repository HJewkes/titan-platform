import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BetSchema } from "@titan-design/pm";
import { writePlanRecord } from "@titan-design/pm/node";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../../cli.js";
import type { Verbs } from "../../cli-types.js";
import { loadRuleFile } from "./rule-file.js";
import { shadowTick } from "./tick.js";
import { calm, enabledRules, fakeRpc, readRows, selectedBet, shadowHome, shadowTickCli, task, writeBrief, writeCharter } from "./tick.test-helpers.js";

/*
 * The tick under the rule file's selection policy (TP-5755 S3): the relax list, the plan-read fallback for a daemon
 * without `plan.*` (amendment A6), and the owner-only lane refusal (amendment A7).
 */

const NOW = "2026-11-18T12:00:00Z";

const bet = selectedBet(1, 1, ["alpha/AL-1", "alpha/AL-2"]);

function homeWith(extra: Record<string, unknown> = {}) {
  const home = shadowHome();
  writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home, extra)));
  return home;
}

const rowsOf = (home: { shadowDir: string }) => readRows(home.shadowDir)[0]!.rows;

/** Answers `task.list` and fails every `plan.*` the way a network fault does. */
function planDown(tasks: Record<string, unknown>[]): typeof globalThis.fetch {
  const served = fakeRpc({ tasks, bets: [] }).fetch;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (String(url).includes("/rpc/plan.")) throw new TypeError("fetch failed");
    return served(url, init);
  };
  return fetch;
}

describe("shadow tick plan read", () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(NOW) }));
  afterEach(() => void vi.useRealTimers());

  it("labels the wake rpc when the daemon serves plan.*", async () => {
    const home = homeWith();

    await shadowTickCli(home, fakeRpc({ tasks: [task(1)], bets: [bet] }).fetch);

    expect(rowsOf(home)[0]).toMatchObject({ kind: "wake", plan_read: "rpc" });
  });

  it("an Unknown command answer falls back to the plan store and labels the wake file", async () => {
    const home = homeWith();
    await writePlanRecord(home.activeRoot, "bet", BetSchema.parse(bet));

    const { code } = await shadowTickCli(home, fakeRpc({ tasks: [task(1)], bets: [], plan: "unknown" }).fetch);

    expect(code).toBe(EXIT.OK);
    expect(rowsOf(home).map((row) => [row.kind, row.task ?? null])).toEqual([
      ["wake", null],
      ["would-dispatch", "alpha/AL-1"],
    ]);
    expect(rowsOf(home)[0]).toMatchObject({ plan_read: "file" });
  });

  it("an absent plan folder under the fallback reads as no bets, not as an error", async () => {
    const home = homeWith();

    const { code } = await shadowTickCli(home, fakeRpc({ tasks: [task(1)], bets: [], plan: "unknown" }).fetch);

    expect(code).toBe(EXIT.OK);
    expect(rowsOf(home).slice(1)).toEqual([expect.objectContaining({ kind: "refused", task: "alpha/AL-1", codes: ["bet-not-selected"] })]);
  });

  it("a network failure on plan.* does not fall back: the lane fails closed and the tick exits 69", async () => {
    const home = homeWith();
    await writePlanRecord(home.activeRoot, "bet", BetSchema.parse(bet));

    const { code } = await shadowTickCli(home, planDown([task(1)]));

    expect(code).toBe(EXIT.UNAVAILABLE);
    expect(rowsOf(home).slice(1)).toEqual([expect.objectContaining({ kind: "refused", task: null, codes: ["signal-unreadable"] })]);
    expect(rowsOf(home)[0]).not.toHaveProperty("plan_read");
  });
});

describe("shadow tick owner-only lanes", () => {
  it("a lane whose initiative is not agent-visible writes one refused row and reads none of its tasks", async () => {
    const home = homeWith({ lanes: [{ initiative: "private-notes", tag: null }, { initiative: "alpha", tag: "lane-a" }] });
    writeBrief(home.activeRoot, "private-notes", "status: active");
    const rpc = fakeRpc({ tasks: [task(1)], bets: [bet] });

    await shadowTickCli(home, rpc.fetch);

    expect(rowsOf(home).filter((row) => JSON.stringify(row.lane ?? null).includes('"private-notes"'))).toEqual([
      expect.objectContaining({ kind: "refused", task: null, stage: "eligibility", codes: ["owner-only-initiative"] }),
    ]);
    expect(rpc.commands.filter((command) => command === "task.list")).toHaveLength(2);
  });

  it("an initiative the charter lists human-only is refused even with an agent-visible brief", async () => {
    const home = homeWith();
    writeCharter(home.activeRoot, ["alpha"]);
    const rpc = fakeRpc({ tasks: [task(1)], bets: [bet] });

    await shadowTickCli(home, rpc.fetch);

    expect(rowsOf(home).slice(1).map((row) => row.codes)).toEqual([["owner-only-initiative"]]);
    expect(rpc.commands).toEqual([]);
  });
});

describe("shadow tick selection policy", () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(NOW) }));
  afterEach(() => void vi.useRealTimers());

  it("a relaxed pass would dispatch with its relaxations and the strict codes on the row", async () => {
    const home = homeWith({ relax: ["bet-field", "no-fold"] });

    await shadowTickCli(home, fakeRpc({ tasks: [task(1, { bet: undefined, fold: undefined })], bets: [bet] }).fetch);

    expect(rowsOf(home)[1]).toMatchObject({ kind: "would-dispatch", task: "alpha/AL-1", bet: "alpha/B1", relaxed: ["bet-field", "no-fold"], strict_codes: ["no-bet", "no-fold"] });
  });

  it("a follow-up from a stopped PR is refused through the stopped-PR port, and an unread port fails closed", async () => {
    const home = homeWith();
    const loaded = loadRuleFile(join(home.dir, "dispatcher.json"))!;
    const followUp = task(1, { source: "follow-up", severity: "high", source_ref: { from_pr: "acme/widgets#12", from_task: "AL-9" } });
    const verbs = partialFake<Verbs>({ io: { stdout: () => {}, stderr: () => {}, env: home.env }, deps: { workflows: [], routes: [], fetch: fakeRpc({ tasks: [followUp, task(2)], bets: [bet] }).fetch, laneSignals: async () => calm } });
    const input = { loaded, verbs, now: new Date(NOW), wake: "w", providers: [] };
    const asked: string[][] = [];

    const stopped = await shadowTick({ ...input, ports: { stoppedPrs: async (prs) => (asked.push([...prs]), new Set(["acme/widgets#12"])) } });
    const unread = await shadowTick({ ...input, ports: { stoppedPrs: async () => Promise.reject(new Error("store locked")) } });

    expect(asked).toEqual([["acme/widgets#12"]]);
    expect(stopped.rows.slice(1).map((row) => (row.kind === "wake" ? [] : [row.kind, row.task, row.kind === "refused" ? row.codes : []]))).toEqual([
      ["refused", "alpha/AL-1", ["intake-from-stopped-pr"]],
      ["would-dispatch", "alpha/AL-2", []],
    ]);
    expect(unread.rows[1]).toMatchObject({ task: "alpha/AL-1", codes: ["signal-unreadable"] });
  });
});
