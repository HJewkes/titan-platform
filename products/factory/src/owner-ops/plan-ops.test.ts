import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnerOp } from "@titan-design/owner-queue";
import type { Bet, Outcome as PlanOutcome } from "@titan-design/pm";
import { loadPlanRecords, readPlanRecord, writePlanRecord } from "@titan-design/pm/node";
import { afterEach, describe, expect, it } from "vitest";
import { actOnOp, OP_EFFECTS } from "../console-action/op.js";
import { ownerOpsLedger, type OwnerOpsLedger } from "./ledger.js";
import { editOutcome, selectBets, setFreeze, type PlanOpDeps } from "./plan-ops.js";
import { planPreview } from "./plan-preview.js";

const CONFIRM = `action:${"d".repeat(64)}`;
const NOW = () => Date.parse("2026-11-16T09:00:00.000Z");
const PLAN_EFFECTS = { "plan-bet-select": selectBets, "plan-outcome-edit": editOutcome, "plan-freeze-set": setFreeze };

const outcome: PlanOutcome = { id: "alpha/faster-landing", initiative: "alpha", statement: "A reviewed change lands the same day", measure: "median hours from review to merge", state: "active" };

const bet = (n: number, overrides: Partial<Bet> = {}): Bet => ({
  id: `alpha/B${n}`,
  initiative: "alpha",
  week: "2026-W47",
  outcome: outcome.id,
  order: n,
  tasks: [`alpha/AL-${n}`],
  prediction: { metric: "median_review_to_merge_hours", direction: "decrease", baseline: 30, expected: 12, read_by: "2026-11-30" },
  state: "proposed",
  ...overrides,
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface World extends PlanOpDeps {
  ledger: OwnerOpsLedger;
  /** One console tap as the route runs it: the authority table, then the effect between the ledger's started and done. */
  tap(op: OwnerOp, actionId?: string): ReturnType<typeof actOnOp>;
}

async function world(): Promise<World> {
  const activeRoot = mkdtempSync(join(tmpdir(), "factory-plan-ops-"));
  const stateDir = mkdtempSync(join(tmpdir(), "factory-plan-ledger-"));
  dirs.push(activeRoot, stateDir);
  mkdirSync(join(activeRoot, "alpha"));
  await writePlanRecord(activeRoot, "outcome", outcome);
  const ledger = ownerOpsLedger(stateDir);
  const deps = { activeRoot, ledger, now: NOW };
  const tap = (op: OwnerOp, actionId = "act-1") => actOnOp(actionId, { op, confirmEvent: CONFIRM }, { effects: PLAN_EFFECTS, ledger, now: NOW }, deps);
  return { ...deps, tap };
}

const selectedFor = async (activeRoot: string, week: string) => (await loadPlanRecords(activeRoot, "alpha", "bet")).filter((each) => each.state === "selected" && each.week === week).map((each) => each.id);

describe("the planning ops on the console's owner-op path", () => {
  it("are the console's effects for their kinds, so a tap reaches them and nothing else", () => {
    expect(OP_EFFECTS).toMatchObject(PLAN_EFFECTS);
  });

  it("selects the named proposed bets for the week, as plan bet list --week then reads them, and logs the tap", async () => {
    const w = await world();
    await Promise.all([bet(1), bet(2), bet(3)].map((each) => writePlanRecord(w.activeRoot, "bet", each)));

    const result = await w.tap({ kind: "plan-bet-select", initiative: "alpha", week: "2026-W47", bets: ["alpha/B1", "alpha/B3"] });

    expect(result).toEqual({ outcome: "plan-applied", op: "plan-bet-select", ids: ["alpha/B1", "alpha/B3"] });
    expect(await selectedFor(w.activeRoot, "2026-W47")).toEqual(["alpha/B1", "alpha/B3"]);
    expect((await w.ledger.read("act-1")).map((line) => line.phase)).toEqual(["started", "done"]);
  });

  it("answers already when every named bet is selected, and refuses the whole tap when one is dropped or of another week", async () => {
    const w = await world();
    await Promise.all([bet(1, { state: "selected" }), bet(2, { state: "dropped" }), bet(3, { week: "2026-W48" })].map((each) => writePlanRecord(w.activeRoot, "bet", each)));
    const select = (bets: string[]): OwnerOp => ({ kind: "plan-bet-select", initiative: "alpha", week: "2026-W47", bets });

    expect(await w.tap(select(["alpha/B1"]))).toEqual({ outcome: "already", ids: ["alpha/B1"] });
    expect(await w.tap(select(["alpha/B1", "alpha/B2"]))).toEqual({ outcome: "refused", reason: "mismatch", detail: "alpha/B2 is dropped now, so it cannot be selected" });
    expect(await w.tap(select(["alpha/B3"]))).toEqual({ outcome: "refused", reason: "mismatch", detail: "alpha/B3 is a bet for 2026-W48, not 2026-W47" });
    expect(await w.tap(select(["alpha/B9"]))).toMatchObject({ outcome: "refused", detail: "no bet alpha/B9 in alpha" });
    expect(await selectedFor(w.activeRoot, "2026-W47")).toEqual(["alpha/B1"]);
  });

  it("answers gone for an initiative with no folder", async () => {
    const w = await world();

    expect(await w.tap({ kind: "plan-bet-select", initiative: "beta", week: "2026-W47", bets: ["beta/B1"] })).toEqual({ outcome: "gone", reason: "Initiative not found: beta" });
  });

  it("round-trips an outcome edit: the preview reads the before, the tap writes the after, a replay is already", async () => {
    const w = await world();
    const to = { statement: "A reviewed change lands within four hours" };
    const before = await planPreview({ kind: "plan-outcome-edit", outcome: outcome.id, to }, w.activeRoot);
    const op: OwnerOp = { kind: "plan-outcome-edit", outcome: outcome.id, to, from: { statement: outcome.statement, measure: outcome.measure } };

    const result = await w.tap(op);
    const replay = await w.tap(op, "act-2");

    expect(before).toEqual({ outcome });
    expect(result).toEqual({ outcome: "plan-applied", op: "plan-outcome-edit", ids: [outcome.id] });
    expect(await readPlanRecord(w.activeRoot, "outcome", outcome.id)).toEqual({ ...outcome, ...to });
    expect(replay).toEqual({ outcome: "refused", reason: "mismatch", detail: `${outcome.id} changed since it was read back; read it again` });
  });

  it("refuses an outcome edit that names nothing to change", async () => {
    const w = await world();

    expect(await w.tap({ kind: "plan-outcome-edit", outcome: outcome.id, to: {} })).toMatchObject({ outcome: "refused", reason: "record" });
  });

  it("sets a freeze as the owner's once per tap, and ends it on the tap's day", async () => {
    const w = await world();
    const set: OwnerOp = { kind: "plan-freeze-set", initiative: "alpha", freeze: { action: "set", tag: "upkeep", reason: "Upkeep waits for the landing bet", end_condition: { kind: "owner" }, intent_ref: "D13", quote_ref: "msg:0f9e8d" } };

    const first = await w.tap(set);
    const replay = await w.tap(set);
    const ended = await w.tap({ kind: "plan-freeze-set", initiative: "alpha", freeze: { action: "end", id: "alpha/F1" } }, "act-3");

    expect(first).toEqual({ outcome: "plan-applied", op: "plan-freeze-set", ids: ["alpha/F1"] });
    expect(replay).toEqual({ outcome: "already", ids: ["alpha/F1"] });
    expect(await loadPlanRecords(w.activeRoot, "alpha", "freeze")).toEqual([{ id: "alpha/F1", initiative: "alpha", tag: "upkeep", reason: "Upkeep waits for the landing bet", end_condition: { kind: "owner" }, set_by: "owner", intent_ref: "D13", quote_ref: "msg:0f9e8d", ended_on: "2026-11-16" }]);
    expect(ended).toEqual({ outcome: "plan-applied", op: "plan-freeze-set", ids: ["alpha/F1"] });
  });

  it("refuses ending a freeze of another initiative than the op names", async () => {
    const w = await world();

    expect(await w.tap({ kind: "plan-freeze-set", initiative: "alpha", freeze: { action: "end", id: "beta/F1" } })).toMatchObject({ outcome: "refused", reason: "record" });
  });

  it("previews each named bet with its outcome, and a missing bet as null", async () => {
    const w = await world();
    await writePlanRecord(w.activeRoot, "bet", bet(1));

    const preview = await planPreview({ kind: "plan-bet-select", initiative: "alpha", week: "2026-W47", bets: ["alpha/B1", "alpha/B2"] }, w.activeRoot);

    expect(preview).toEqual({ bets: [{ id: "alpha/B1", bet: bet(1), outcome }, { id: "alpha/B2", bet: null, outcome: null }] });
  });
});
