import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { depositItemId, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { readAnswer, withdrawnFileName, writeAnswer, writeDeposit } from "@titan-design/owner-queue/spool";
import { spoolQueueItems } from "./approval-items.js";
import { createDecisionLog, type DecisionLog } from "./decision-log.js";
import { sweepDeposits } from "./deposit-by-rec.js";

const ASKER = "seat-alpha";
const HOUR = 3_600_000;
const SHA = "a".repeat(40);
const ROW = z.record(z.string(), z.unknown());

let dir: string;
const stateDir = () => path.join(dir, "state");
const inboxDir = () => path.join(dir, "deposits");
const idOf = (depositId = "pick-colour") => depositItemId(ASKER, depositId);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "deposit-by-rec-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deposit(overrides: Partial<OwnerItemDeposit> = {}): OwnerItemDeposit {
  return {
    depositId: "pick-colour",
    asker: ASKER,
    kind: "decide",
    door: "two-way",
    summary: "Which accent colour should the sample page use?",
    context: "Two palettes scored the same in the synthetic contrast check.",
    options: [
      { id: "teal", label: "Teal" },
      { id: "amber", label: "Amber" },
    ],
    recommended: { optionId: "amber", by: ASKER, rationale: "Higher contrast on dark" },
    ...overrides,
  };
}

/** Deposits stamp `openedAt` with the wall clock, so each sweep runs at a time measured from the filed item. */
async function file(overrides: Partial<OwnerItemDeposit> = {}): Promise<number> {
  await writeDeposit(inboxDir(), deposit(overrides));
  const [item] = (await spoolQueueItems(inboxDir())).open.filter((each) => each.id === idOf(overrides.depositId));
  return Date.parse(item?.openedAt ?? "");
}

async function setPolicy(policy: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(stateDir(), "auto-by-rec-policy.json"), JSON.stringify({ schema: "titan/auto-by-rec-policy@1", ...policy }));
}

async function rows(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(stateDir(), "auto-by-rec.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => ROW.parse(JSON.parse(line)));
}

function recordingLog(): DecisionLog & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return { calls, record: async (...args) => (calls.push(args), { ledger: "written", decisions: "not-configured" }) };
}

async function live(): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await setPolicy({ mode: "live" });
}

describe("deposit by-rec sweep, live", () => {
  beforeEach(live);

  it("decides a deposit silent 24 h once, as the automation, and the asker reads the answer", async () => {
    const opened = await file();
    const decisionLog = recordingLog();
    const sweep = () => sweepDeposits({ stateDir: stateDir(), inboxDir: inboxDir(), decisionLog, now: () => opened + 24 * HOUR });

    const first = await sweep();
    const second = await sweep();

    expect(first.outcomes).toEqual([{ id: idOf(), result: "resolved" }]);
    expect(second.outcomes).toEqual([]);
    expect(await readAnswer(inboxDir(), idOf())).toMatchObject({ optionId: "amber", by: { class: "automation", id: "auto-by-rec", channel: "console-sweep" } });
    expect(decisionLog.calls).toHaveLength(1);
    expect((await spoolQueueItems(inboxDir())).answered.map(({ status }) => status)).toEqual(["decided"]);
    const [row, ...more] = await rows();
    expect(more).toEqual([]);
    expect(row).toMatchObject({ schema: "titan/auto-by-rec@1", mode: "live", result: "resolved", subject: { source: "deposit", id: idOf() }, recommendation: { answer: "amber", rationale: "Higher contrast on dark" } });
  });

  it("leaves a deposit at 23 h 59 m open", async () => {
    const opened = await file();

    const report = await sweepDeposits({ stateDir: stateDir(), inboxDir: inboxDir(), now: () => opened + 24 * HOUR - 60_000 });

    expect(report.outcomes).toEqual([{ id: idOf(), result: "skipped", reason: "too-early" }]);
    expect(await readAnswer(inboxDir(), idOf())).toBeUndefined();
  });

  it("takes the default at the asker's own apply-default 6 h", async () => {
    const opened = await file({ default: "amber", onSilence: { action: "apply-default", afterHours: 6 } });

    const early = await sweepDeposits({ stateDir: stateDir(), inboxDir: inboxDir(), now: () => opened + 6 * HOUR - 1 });
    const due = await sweepDeposits({ stateDir: stateDir(), inboxDir: inboxDir(), now: () => opened + 6 * HOUR });

    expect(early.outcomes.map(({ result }) => result)).toEqual(["skipped"]);
    expect(due.outcomes).toEqual([{ id: idOf(), result: "resolved" }]);
  });

  it("never overwrites an answer the owner filed first", async () => {
    const opened = await file();
    await writeAnswer(inboxDir(), idOf(), { optionId: "teal", by: { class: "owner-remote", id: "titan-console", channel: "console:inbox" }, at: new Date(opened).toISOString() });

    const report = await sweepDeposits({ stateDir: stateDir(), inboxDir: inboxDir(), now: () => opened + 48 * HOUR });

    expect(report.outcomes).toEqual([]);
    expect(await readAnswer(inboxDir(), idOf())).toMatchObject({ optionId: "teal" });
  });

  it("leaves a deposit that lapsed before its wait unanswered", async () => {
    const opened = await file({ expiresAt: new Date(Date.now() + HOUR).toISOString() });

    const report = await sweepDeposits({ stateDir: stateDir(), inboxDir: inboxDir(), now: () => opened + 24 * HOUR });

    expect(report.outcomes).toEqual([{ id: idOf(), result: "skipped", reason: "expired" }]);
    expect(await readAnswer(inboxDir(), idOf())).toBeUndefined();
    expect(await rows()).toEqual([]);
  });

  it("treats a deposit whose withdrawal marker is malformed as closed", async () => {
    const opened = await file();
    await writeFile(path.join(inboxDir(), withdrawnFileName(idOf())), "{not json");

    const report = await sweepDeposits({ stateDir: stateDir(), inboxDir: inboxDir(), now: () => opened + 48 * HOUR });

    expect(report.outcomes).toEqual([{ id: idOf(), result: "skipped", reason: "unreadable" }]);
    expect(await readAnswer(inboxDir(), idOf())).toBeUndefined();
    expect(await rows()).toEqual([]);
  });

  const exclusions: Array<[string, Partial<OwnerItemDeposit>, string]> = [
    ["onSilence wait", { onSilence: { action: "wait" } }, "floor:on-silence-wait"],
    ["a one-way door", { door: "one-way", irreversible: "Deletes the sample archive", onSilence: { action: "wait" } }, "floor:one-way"],
    ["an irreversible deposit", { irreversible: "Sends the sample mail" }, "floor:irreversible"],
    ["a deposit op", { kind: "approve", op: { kind: "close-pr", repo: "example/sample", pr: 7, headSha: SHA } }, "floor:owner-op"],
    ["a do step", { kind: "do" }, "floor:not-a-decision"],
    ["a personal item", { personal: true }, "floor:personal"],
    ["an operator-audience item", { audience: "operator" }, "floor:operator-audience"],
    ["no recommendation", { recommended: undefined }, "floor:no-recommendation"],
    ["no options", { options: undefined }, "no-options"],
    ["a dollar amount", { context: "The sample plan costs $40 a month." }, "floor:money"],
  ];

  it.each(exclusions)("skips %s with a reason and files no answer", async (_name, overrides, reason) => {
    const opened = await file(overrides);

    const report = await sweepDeposits({ stateDir: stateDir(), inboxDir: inboxDir(), now: () => opened + 48 * HOUR });

    expect(report.outcomes).toEqual([{ id: idOf(), result: "skipped", reason }]);
    expect(await readAnswer(inboxDir(), idOf())).toBeUndefined();
    expect(await rows()).toEqual([]);
  });

  it("ledgers the answer as the decider's, not the owner's, with the automation named", async () => {
    const opened = await file();
    const decisionLog = createDecisionLog({ stateDir: stateDir(), decisionsFile: null, humanOnly: async () => ({ known: true, initiatives: new Set() }) });

    await sweepDeposits({ stateDir: stateDir(), inboxDir: inboxDir(), decisionLog, now: () => opened + 24 * HOUR });

    const [ledger] = (await readFile(path.join(stateDir(), "answers.jsonl"), "utf8")).split("\n").map((line) => (line ? ROW.parse(JSON.parse(line)) : null));
    expect(ledger).toMatchObject({ answered_by: "decider", answer: "Amber", by: { class: "automation", id: "auto-by-rec" } });
  });
});

describe("deposit by-rec sweep, shadow and off", () => {
  it("writes one would-resolve row and no answer when no policy file exists", async () => {
    const opened = await file();
    const sweep = () => sweepDeposits({ stateDir: stateDir(), inboxDir: inboxDir(), now: () => opened + 24 * HOUR });

    const first = await sweep();
    const second = await sweep();

    expect(first).toMatchObject({ mode: "shadow", outcomes: [{ id: idOf(), result: "would-resolve" }] });
    expect(second.outcomes).toEqual([{ id: idOf(), result: "already" }]);
    expect(await readAnswer(inboxDir(), idOf())).toBeUndefined();
    expect((await rows()).map(({ mode, result }) => [mode, result])).toEqual([["shadow", "would-resolve"]]);
  });

  it("does nothing when the policy says off", async () => {
    const opened = await file();
    await mkdir(stateDir(), { recursive: true });
    await setPolicy({ mode: "off" });

    const report = await sweepDeposits({ stateDir: stateDir(), inboxDir: inboxDir(), now: () => opened + 48 * HOUR });

    expect(report).toEqual({ mode: "off", outcomes: [], gaps: [] });
    expect(await rows()).toEqual([]);
  });

  it("turns off, with a gap, when the policy file does not parse", async () => {
    const opened = await file();
    await mkdir(stateDir(), { recursive: true });
    await setPolicy({ mode: "live", allow: ["g10-hold"] });

    const report = await sweepDeposits({ stateDir: stateDir(), inboxDir: inboxDir(), now: () => opened + 48 * HOUR });

    expect(report.mode).toBe("off");
    expect(report.gaps).toEqual(["auto-by-rec-policy.json could not be read; the deposit sweep is off"]);
    expect(await readAnswer(inboxDir(), idOf())).toBeUndefined();
  });
});
