import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { BY_REC_POLICY_SCHEMA, BY_REC_RESOLVER, BY_REC_ROW_SCHEMA, depositItemId, roundItemId, type ByRecRow } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { EXIT } from "@titan-design/registry";
import { appendByRecRows, BY_REC_POLICY_FILE, readByRecRows } from "./by-rec-log.js";
import type { DecisionLog } from "./decision-log.js";
import { sweepDeposits } from "./deposit-by-rec.js";
import { logOverruleCommands, overrule, type OverruleDeps } from "./log-overrule.js";
import type { ConsoleContext } from "./owner-guard.js";

const ASKER = "seat-alpha";
const DEPOSIT_ID = depositItemId(ASKER, "pick-colour");
const HOUR = 3_600_000;
const SESSION_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };

let root: string;
let recorded: Parameters<DecisionLog["record"]>[];
let told: { seat: string; text: string }[];

function deps(): OverruleDeps {
  const decisionLog: DecisionLog = { record: async (...args) => (recorded.push(args), { ledger: "written", decisions: "written" }) };
  return {
    stateDir: path.join(root, "state"),
    inboxDir: path.join(root, "deposits"),
    roundsDir: path.join(root, "rounds"),
    decisionLog,
    notify: async (seat, text) => void told.push({ seat, text }),
    now: () => Date.parse("2031-03-07T09:00:00.000Z"),
  };
}

/** A deposit the live deposit sweep answered with its recommendation, amber. */
async function resolvedDeposit(): Promise<void> {
  const { stateDir, inboxDir } = deps();
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, BY_REC_POLICY_FILE), JSON.stringify({ schema: BY_REC_POLICY_SCHEMA, mode: "live" }));
  await writeDeposit(inboxDir, {
    depositId: "pick-colour", asker: ASKER, kind: "decide", door: "two-way",
    summary: "Which accent colour should the sample page use?", context: "Two synthetic palettes tied.",
    options: [{ id: "teal", label: "Teal" }, { id: "amber", label: "Amber" }],
    recommended: { optionId: "amber", by: ASKER, rationale: "Higher contrast on dark" },
  });
  const report = await sweepDeposits({ stateDir, inboxDir, now: () => Date.now() + 25 * HOUR });
  expect(report.outcomes).toEqual([{ id: DEPOSIT_ID, result: "resolved" }]);
}

const overrules = async (): Promise<ByRecRow[]> => (await readByRecRows(deps().stateDir)).filter((row) => row.result === "overruled");

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "log-overrule-"));
  recorded = [];
  told = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("overruling a deposit auto-by-rec answered", () => {
  it("overrule writes one row and one asker notice", async () => {
    await resolvedDeposit();

    const result = await overrule(deps(), { source: "deposit", id: DEPOSIT_ID, optionId: "teal" });

    expect(result).toMatchObject({ from: "Amber", to: "Teal", seat: ASKER, notice: "sent", log: { ledger: "written" } });
    const [row] = await overrules();
    expect(await overrules()).toHaveLength(1);
    expect(row).toMatchObject({ subject: { source: "deposit", id: DEPOSIT_ID }, recommendation: { answer: "amber" }, mode: "live", overrule: { answer: "teal", by: { class: "owner-remote" } } });
    expect(told).toEqual([{ seat: ASKER, text: expect.stringContaining('Auto-by-rec picked "Amber"; the owner picks "Teal"') }]);
    expect(recorded.map(([item, answer]) => [item.id, answer.optionId, answer.by.class])).toEqual([[DEPOSIT_ID, "teal", "owner-remote"]]);
  });

  it("refuses a second overrule of the same row, and writes nothing more", async () => {
    await resolvedDeposit();
    await overrule(deps(), { source: "deposit", id: DEPOSIT_ID, optionId: "teal" });

    await expect(overrule(deps(), { source: "deposit", id: DEPOSIT_ID, optionId: "teal" })).rejects.toThrow("already overruled");
    expect(await overrules()).toHaveLength(1);
    expect(told).toHaveLength(1);
  });

  it("refuses the pick auto-by-rec already took, and a pick the deposit never offered", async () => {
    await resolvedDeposit();

    await expect(overrule(deps(), { source: "deposit", id: DEPOSIT_ID, optionId: "amber" })).rejects.toThrow("already took");
    await expect(overrule(deps(), { source: "deposit", id: DEPOSIT_ID, optionId: "violet" })).rejects.toThrow("not one of the item's options");
    expect(await overrules()).toEqual([]);
  });

  it("refuses a deposit with only a shadow row, since nothing was applied", async () => {
    await expect(overrule(deps(), { source: "deposit", id: DEPOSIT_ID, optionId: "teal" })).rejects.toMatchObject({ code: EXIT.NOINPUT });
  });
});

describe("overruling a round question auto-by-rec answered", () => {
  it("tells the round's asker and records the question as an owner answer", async () => {
    const { roundsDir, stateDir } = deps();
    const roundDir = path.join(roundsDir, "kiln-r1");
    await mkdir(roundDir, { recursive: true });
    await writeFile(path.join(roundDir, "round.json"), JSON.stringify(roundManifest()));
    await writeFile(path.join(roundDir, "asker.json"), JSON.stringify({ schema: "titan-console/asker@1", seat: "seat-kiln", initiative: null, filedAt: "2031-03-05T00:00:00.000Z" }));
    await appendByRecRows(stateDir, [resolvedRoundRow()]);

    const result = await overrule(deps(), { source: "round", id: roundItemId("kiln-r1", "ramp"), optionId: "Single" });

    expect(result).toMatchObject({ from: "Staged", to: "Single", seat: "seat-kiln", notice: "sent" });
    expect(recorded.map(([item, answer]) => [item.id, answer.optionId])).toEqual([[roundItemId("kiln-r1", "ramp"), "Single"]]);
  });
});

describe("the overrule command", () => {
  const context = (auth: RequestAuth | null): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth, ownerWrites: true });

  it("refuses a non-owner caller before anything is written", async () => {
    await resolvedDeposit();
    const command = logOverruleCommands(deps())["log.overrule"];

    const tap = async (auth: RequestAuth | null) => command.run({ source: "deposit", id: DEPOSIT_ID, optionId: "teal" }, context(auth));

    await expect(tap(null)).rejects.toMatchObject({ code: EXIT.NOPERM });
    await expect(tap({ ...SESSION_AUTH, peerLocal: true })).rejects.toMatchObject({ code: EXIT.NOPERM });
    expect(await overrules()).toEqual([]);
    expect(told).toEqual([]);
  });

  it("lists the picks with the taken one marked, and names the refusal a non-owner would meet", async () => {
    await resolvedDeposit();
    const read = logOverruleCommands(deps())["log.overrule-options"];

    const options = await read.run({ source: "deposit", id: DEPOSIT_ID }, context(null));

    expect(options.options).toEqual([{ id: "teal", label: "Teal", recommended: false }, { id: "amber", label: "Amber", recommended: true }]);
    expect(options.refusal).toContain("session cookie");
    expect((await read.run({ source: "deposit", id: DEPOSIT_ID }, context(SESSION_AUTH))).refusal).toBeNull();
  });
});

function roundManifest(): Record<string, unknown> {
  const ramp = { id: "ramp", kind: "pick-one", prompt: "Which ramp by default?", options: ["Staged", "Single"], required: true, signsOff: "ramp-part", recommendation: { answer: "Staged", by: "fixture-agent", rationale: "Fewer cracked pots.", confidence: 0.6 } };
  return {
    schema: "titan-review/round@2", unit: "kiln", round: 1, storybookUrl: "http://127.0.0.1:6006", context: "A synthetic kiln round.", widths: [1280], variants: [], recommendations: "shown",
    sections: [{ id: "main", title: "Main", deciding: "The defaults.", changed: "Nothing real.", context: "Synthetic.", questionIds: ["ramp"], parts: [{ id: "ramp-part", label: "ramp", proposed: "ramp" }] }],
    questions: [ramp],
  };
}

function resolvedRoundRow(): ByRecRow {
  return {
    schema: BY_REC_ROW_SCHEMA, subject: { source: "round", id: roundItemId("kiln-r1", "ramp"), summary: "Which ramp by default?" }, recommendation: { answer: "Staged", by: "fixture-agent" },
    openedAt: "2031-03-05T00:00:00.000Z", resolvedAt: "2031-03-06T01:00:00.000Z", facts: { roundId: "kiln-r1", questionId: "ramp" }, mode: "live", result: "resolved", resolver: { ...BY_REC_RESOLVER },
  };
}
