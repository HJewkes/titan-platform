import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { depositItemId, type OwnerItemDeposit } from "./deposit.js";
import { readAnswer, readSpool, writeAnswer, writeDeposit } from "./spool.js";
import { readWithdrawal, restoreDeposit, WITHDRAW_LOG, withdrawDeposit, withdrawMatching, WithdrawRefusedError } from "./withdraw.js";

const NOW = new Date("2031-03-05T12:00:00.000Z");
const LATER = new Date("2031-03-05T13:00:00.000Z");
const ID = depositItemId("seat-a", "d-1");

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "owner-queue-withdraw-"));
  dir = join(root, "deposits");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deposit(overrides: Partial<OwnerItemDeposit> = {}): OwnerItemDeposit {
  return { depositId: "d-1", asker: "seat-a", kind: "do", door: "two-way", summary: "Restart the cache", context: "It stopped answering.", ...overrides };
}

const logLines = z.array(z.record(z.string(), z.string()));
const log = async (): Promise<Record<string, string>[]> =>
  logLines.parse((await readFile(join(dir, WITHDRAW_LOG), "utf8")).trim().split("\n").map((line): unknown => JSON.parse(line)));

async function refusal(run: Promise<unknown>): Promise<WithdrawRefusedError> {
  const error = await run.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(WithdrawRefusedError);
  if (!(error instanceof WithdrawRefusedError)) throw new Error("not a WithdrawRefusedError");
  return error;
}

describe("withdrawDeposit", () => {
  it("marks the asker's own deposit withdrawn, writes no answer, and logs who, when and why", async () => {
    await writeDeposit(dir, deposit());

    expect(await withdrawDeposit(dir, ID, { reason: "obsolete", as: "seat-a", now: NOW })).toEqual({ id: ID, outcome: "withdrawn" });

    expect(await readWithdrawal(dir, ID)).toEqual({ reason: "obsolete", by: "seat-a", at: NOW.toISOString() });
    expect(await readAnswer(dir, ID)).toBeUndefined();
    expect(await log()).toEqual([{ op: "withdraw", id: ID, reason: "obsolete", by: "seat-a", at: NOW.toISOString() }]);
    expect((await readSpool(dir)).items.map((item) => item.id)).toEqual([ID]);
  });

  it("keeps the first reason when the same deposit is withdrawn again", async () => {
    await writeDeposit(dir, deposit());
    await withdrawDeposit(dir, ID, { reason: "superseded:deposit:abc", as: "seat-a", now: NOW });

    expect(await withdrawDeposit(dir, ID, { reason: "resolved", as: "seat-a", now: LATER })).toEqual({ id: ID, outcome: "already-withdrawn" });

    expect(await readWithdrawal(dir, ID)).toMatchObject({ reason: "superseded:deposit:abc" });
    expect(await log()).toHaveLength(1);
  });

  it("refuses a seat that did not file the deposit", async () => {
    await writeDeposit(dir, deposit());

    const error = await refusal(withdrawDeposit(dir, ID, { reason: "obsolete", as: "seat-b", now: NOW }));

    expect(error.kind).toBe("refused");
    expect(error.message).toBe(`${ID} was filed by seat-a, not seat-b`);
    expect(await readWithdrawal(dir, ID)).toBeUndefined();
  });

  it("refuses an item that is not a deposit, such as a hitl gate or a round question", async () => {
    await writeDeposit(dir, deposit());

    for (const id of ["gate:g-1", "round:kiln-r1/q1"]) {
      const error = await refusal(withdrawDeposit(dir, id, { reason: "obsolete", as: "seat-a", now: NOW }));
      expect([error.kind, error.message]).toEqual(["refused", `${id} is not a deposit; only a seat's own deposits can be withdrawn`]);
    }
  });

  it("reports a deposit id the spool does not hold as unknown", async () => {
    const error = await refusal(withdrawDeposit(dir, depositItemId("seat-a", "never-filed"), { reason: "obsolete", as: "seat-a", now: NOW }));

    expect(error.kind).toBe("unknown");
  });

  it("refuses a reason outside obsolete, resolved and superseded:<id>", async () => {
    await writeDeposit(dir, deposit());

    for (const reason of ["stale", "superseded:", "resolved because"]) {
      expect((await refusal(withdrawDeposit(dir, ID, { reason, as: "seat-a", now: NOW }))).kind).toBe("refused");
    }
    expect(await readdir(dir)).not.toContain(WITHDRAW_LOG);
  });

  it("refuses a deposit the owner already answered, so the answer stands", async () => {
    await writeDeposit(dir, deposit());
    await writeAnswer(dir, ID, { text: "done", by: { class: "owner", id: "o", channel: "web" }, at: NOW.toISOString() });

    const error = await refusal(withdrawDeposit(dir, ID, { reason: "resolved", as: "seat-a", now: NOW }));

    expect(error.message).toBe(`${ID} is already answered; the owner's answer stands`);
    expect(await readWithdrawal(dir, ID)).toBeUndefined();
  });
});

describe("restoreDeposit", () => {
  it("opens a withdrawn deposit again and logs the restore after the withdraw", async () => {
    await writeDeposit(dir, deposit());
    await withdrawDeposit(dir, ID, { reason: "obsolete", as: "seat-a", now: NOW });

    expect(await restoreDeposit(dir, ID, { as: "seat-a", now: LATER })).toEqual({ id: ID, outcome: "restored" });

    expect(await readWithdrawal(dir, ID)).toBeUndefined();
    expect(await log()).toEqual([
      { op: "withdraw", id: ID, reason: "obsolete", by: "seat-a", at: NOW.toISOString() },
      { op: "restore", id: ID, by: "seat-a", at: LATER.toISOString() },
    ]);
  });

  it("says so when the deposit was never withdrawn", async () => {
    await writeDeposit(dir, deposit());

    expect(await restoreDeposit(dir, ID, { as: "seat-a", now: NOW })).toEqual({ id: ID, outcome: "not-withdrawn" });
  });

  it("refuses a seat that did not file the deposit and leaves it withdrawn", async () => {
    await writeDeposit(dir, deposit());
    await withdrawDeposit(dir, ID, { reason: "obsolete", as: "seat-a", now: NOW });

    expect((await refusal(restoreDeposit(dir, ID, { as: "seat-b", now: LATER }))).message).toBe(`${ID} was filed by seat-a, not seat-b`);

    expect(await readWithdrawal(dir, ID)).toMatchObject({ reason: "obsolete" });
  });
});

describe("withdrawMatching", () => {
  async function fileMixedSpool(): Promise<void> {
    await writeDeposit(dir, deposit({ depositId: "alarm-1", keys: ["deploy-alarm"] }));
    await writeDeposit(dir, deposit({ depositId: "alarm-2", keys: ["topic:x", "deploy-incident"] }));
    await writeDeposit(dir, deposit({ depositId: "answered", keys: ["deploy-alarm"] }));
    await writeDeposit(dir, deposit({ depositId: "other-key", keys: ["topic:x"] }));
    await writeDeposit(dir, deposit({ depositId: "alarm-1", asker: "seat-b", keys: ["deploy-alarm"] }));
    await writeAnswer(dir, depositItemId("seat-a", "answered"), { text: "ok", by: { class: "owner", id: "o", channel: "web" }, at: NOW.toISOString() });
  }

  it("withdraws only the asker's open deposits that carry one of the keys", async () => {
    await fileMixedSpool();

    const withdrawn = await withdrawMatching(dir, { asker: "seat-a", keys: ["deploy-alarm", "deploy-incident"], reason: "resolved", now: NOW });

    const expected = [depositItemId("seat-a", "alarm-1"), depositItemId("seat-a", "alarm-2")].sort();
    expect(withdrawn.map((item) => item.id).sort()).toEqual(expected);
    expect((await log()).map((entry) => entry.id).sort()).toEqual(expected);
    expect(await readWithdrawal(dir, depositItemId("seat-b", "alarm-1"))).toBeUndefined();
    expect(await withdrawMatching(dir, { asker: "seat-a", keys: ["deploy-alarm", "deploy-incident"], reason: "resolved", now: LATER })).toEqual([]);
  });

  it("lists the matches and writes nothing on a dry run", async () => {
    await fileMixedSpool();

    const listed = await withdrawMatching(dir, { asker: "seat-a", keys: ["deploy-alarm"], reason: "resolved", now: NOW, dryRun: true });

    expect(listed.map((item) => item.id)).toEqual([depositItemId("seat-a", "alarm-1")]);
    expect(await readWithdrawal(dir, depositItemId("seat-a", "alarm-1"))).toBeUndefined();
    expect(await readdir(dir)).not.toContain(WITHDRAW_LOG);
  });
});
