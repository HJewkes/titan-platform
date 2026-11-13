import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { depositItemId, type OwnerOp } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import type { Bet, Freeze, Outcome } from "@titan-design/pm";
import { EXIT, invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import { z } from "zod";
import { factoryNeeds } from "./factory.js";
import { inboxActionCommands, type PrepareResult } from "./inbox-actions.js";
import type { ActionOutcome, OwnerActionClient } from "./owner-action.js";
import type { ConsoleContext } from "./owner-guard.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

const ASKER = "test-planner";
const SESSION: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const BEARER: RequestAuth = { credential: "bearer", issuedAt: null, peerLocal: false };
const HV = { verdict: "gate", ruleId: "HV-OR", resolvers: ["owner-remote"], reason: "read back first" };

const outcome: Outcome = { id: "alpha/faster-landing", initiative: "alpha", statement: "A reviewed change lands the same day", measure: "median hours from review to merge", state: "active" };
const bet = (n: number, state: Bet["state"] = "proposed"): Bet => ({
  id: `alpha/B${n}`,
  initiative: "alpha",
  week: "2026-W47",
  outcome: outcome.id,
  order: n,
  tasks: [`alpha/AL-${n}`],
  prediction: { metric: "median_review_to_merge_hours", direction: "decrease", baseline: 30, expected: 12, read_by: "2026-11-30" },
  state,
});
const freeze: Freeze = { id: "alpha/F1", initiative: "alpha", tag: "upkeep", reason: "Upkeep waits for the landing bet", end_condition: { kind: "task-done", task: "alpha/AL-2" }, set_by: "owner", intent_ref: "D13", quote_ref: "msg:0f9e8d" };

let dir: string;
let factory: FakeDaemon | undefined;
let plan: unknown;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-inbox-plan-"));
  plan = { bets: [{ id: "alpha/B1", bet: bet(1), outcome }, { id: "alpha/B2", bet: bet(2), outcome }] };
});

afterEach(async () => {
  await factory?.close();
  factory = undefined;
  await rm(dir, { recursive: true, force: true });
});

const actionsDir = () => path.join(dir, "owner-actions");
const records = () => readdir(actionsDir()).catch(() => [] as string[]);

async function deposit(op: OwnerOp, summary: string): Promise<string> {
  await writeDeposit(path.join(dir, "deposits"), { depositId: "plan-1", asker: ASKER, kind: "do", door: "one-way", summary, context: "", keys: [], command: "active-work plan bet list --state proposed", op });
  return depositItemId(ASKER, "plan-1");
}

/** The factory as a plan record meets it: it reads the op the console wrote and answers with what it applied. */
function planFactory(answer: ActionOutcome = { status: "plan-applied", op: "plan-bet-select", ids: ["alpha/B1", "alpha/B2"] }) {
  const posted: unknown[] = [];
  const client: OwnerActionClient = {
    post: async (actionId) => {
      posted.push(JSON.parse(await readFile(path.join(actionsDir(), `${actionId}.json`), "utf8")).op);
      return answer;
    },
  };
  return { client, posted };
}

async function harness(client: OwnerActionClient) {
  factory = await startFakeDaemon({ ok: true }, (command, args) => {
    if (command === "needs.list") return { items: [], gaps: [] };
    if (command === "shepherd.list") return [];
    if (command === "owner-op.preview") return { kind: z.object({ kind: z.string() }).parse(args.op).kind, authority: HV, plan };
    throw new Error(`no fixture for ${command}`);
  });
  const sources = { factory: factoryNeeds(factory.port), shepherd: shepherdReader(factory.port), rounds: { dir: path.join(dir, "rounds") }, inbox: { dir: path.join(dir, "deposits") } };
  const commands = inboxActionCommands(sources, { enabled: true, actionsDir: actionsDir(), client, now: () => Date.parse("2026-11-16T09:00:00.000Z") });
  const context = (auth: RequestAuth): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth, ownerWrites: true });
  return {
    prepare: async (itemId: string) => (await invokeCommand(commands["inbox.prepare"], { itemId }, context(SESSION))).envelope,
    act: (itemId: string, confirm: string, auth = SESSION) => invokeCommand(commands["inbox.act"], { itemId, confirm }, context(auth)),
  };
}

const ready = (envelope: JsonEnvelope<unknown>) => z.object({ ok: z.literal(true), data: z.custom<Extract<PrepareResult, { status: "ready" }>>((data) => z.object({ status: z.literal("ready") }).safeParse(data).success) }).parse(envelope).data;

const SELECT: OwnerOp = { kind: "plan-bet-select", initiative: "alpha", week: "2026-W47", bets: ["alpha/B1", "alpha/B2"] };

describe("inbox plan-bet-select op", () => {
  it("reads each bet back with its outcome, prediction and tasks, posts the op as deposited, and lands the selection", async () => {
    const itemId = await deposit(SELECT, "Pick this week's bets");
    const spy = planFactory();
    const { prepare, act } = await harness(spy.client);

    const prepared = ready(await prepare(itemId));
    const { envelope } = await act(itemId, prepared.confirm);

    expect(prepared.readBack).toMatchObject({
      planOp: "bet-select",
      week: "2026-W47",
      authority: "HV-OR: gate",
      proposedBy: ASKER,
      effect: "Select alpha/B1, alpha/B2 as your bets for 2026-W47; agents plan the week from selected bets only",
      bets: [
        { id: "alpha/B1", outcome: outcome.id, outcomeStatement: outcome.statement, prediction: bet(1).prediction, tasks: ["alpha/AL-1"] },
        { id: "alpha/B2", outcome: outcome.id, outcomeStatement: outcome.statement, tasks: ["alpha/AL-2"] },
      ],
    });
    expect(spy.posted).toEqual([SELECT]);
    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "plan-applied" }, message: "Selected alpha/B1, alpha/B2; plan bet list --week now returns them" } });
  });

  it("refuses a tap that is not owner-proven, a bearer credential, with 403 and writes nothing", async () => {
    const itemId = await deposit(SELECT, "Pick this week's bets");
    const spy = planFactory();
    const { prepare, act } = await harness(spy.client);
    const { confirm } = ready(await prepare(itemId));

    const { envelope, exitCode } = await act(itemId, confirm, BEARER);

    expect(exitCode).toBe(EXIT.NOPERM);
    expect(envelope.ok).toBe(false);
    expect(await records()).toEqual([]);
    expect(spy.posted).toEqual([]);
  });

  it("offers no tap when a named bet is dropped, or every one is already selected", async () => {
    const itemId = await deposit(SELECT, "Pick this week's bets");
    const { prepare } = await harness(planFactory().client);

    plan = { bets: [{ id: "alpha/B1", bet: bet(1), outcome }, { id: "alpha/B2", bet: bet(2, "dropped"), outcome }] };
    expect(await prepare(itemId)).toMatchObject({ data: { status: "no-action", reason: "alpha/B2 is dropped, so it cannot be selected" } });
    plan = { bets: [{ id: "alpha/B1", bet: bet(1, "selected"), outcome }, { id: "alpha/B2", bet: bet(2, "selected"), outcome }] };
    expect(await prepare(itemId)).toMatchObject({ data: { status: "no-action", reason: "every bet named is already selected for 2026-W47" } });
  });
});

describe("inbox plan-outcome-edit op", () => {
  it("reads the statement back before and after, and posts the before so a moved outcome refuses", async () => {
    const to = { statement: "A reviewed change lands within four hours" };
    const itemId = await deposit({ kind: "plan-outcome-edit", outcome: outcome.id, to }, "Tighten the landing outcome");
    plan = { outcome };
    const spy = planFactory({ status: "plan-applied", op: "plan-outcome-edit", ids: [outcome.id] });
    const { prepare, act } = await harness(spy.client);

    const prepared = ready(await prepare(itemId));
    const { envelope } = await act(itemId, prepared.confirm);

    expect(prepared.readBack).toMatchObject({ planOp: "outcome-edit", before: { statement: outcome.statement, measure: outcome.measure }, after: { statement: to.statement, measure: outcome.measure }, effect: `Replace the statement of ${outcome.id}` });
    expect(spy.posted).toEqual([{ kind: "plan-outcome-edit", outcome: outcome.id, to, from: { statement: outcome.statement, measure: outcome.measure } }]);
    expect(envelope).toMatchObject({ ok: true, data: { message: `Outcome ${outcome.id} updated` } });
  });
});

describe("inbox plan-freeze-set op", () => {
  it("reads back what a new freeze stops and when it ends, set as the owner's", async () => {
    const op: OwnerOp = { kind: "plan-freeze-set", initiative: "alpha", freeze: { action: "set", tag: "upkeep", reason: freeze.reason, end_condition: { kind: "date", date: "2026-11-30" }, intent_ref: "D13", quote_ref: "msg:0f9e8d" } };
    const itemId = await deposit(op, "Freeze upkeep this week");
    plan = {};
    const { prepare } = await harness(planFactory().client);

    expect(ready(await prepare(itemId)).readBack).toMatchObject({ planOp: "freeze", action: "set", stops: "tasks tagged upkeep", ends: "on 2026-11-30", reason: freeze.reason, effect: "Freeze tasks tagged upkeep in alpha as yours; it ends on 2026-11-30" });
  });

  it("reads back a standing freeze to end, and offers none for one already ended", async () => {
    const itemId = await deposit({ kind: "plan-freeze-set", initiative: "alpha", freeze: { action: "end", id: freeze.id } }, "End the upkeep freeze");
    plan = { freeze };
    const { prepare } = await harness(planFactory().client);

    expect(ready(await prepare(itemId)).readBack).toMatchObject({ planOp: "freeze", action: "end", freezeId: freeze.id, ends: "when alpha/AL-2 is done", effect: "End alpha/F1 today; tasks tagged upkeep may be worked again" });
    plan = { freeze: { ...freeze, ended_on: "2026-11-15" } };
    expect(await prepare(itemId)).toMatchObject({ data: { status: "no-action", reason: "alpha/F1 already ended on 2026-11-15" } });
  });
});
