import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { depositItemId, fromDeposit, type OwnerItemDeposit } from "./deposit.js";
import { readSpool, writeDeposit } from "./spool.js";
import { readWithdrawal, withdrawDeposit } from "./withdraw.js";

const NOW = new Date("2031-03-05T12:00:00.000Z");
const SINCE = "2031-03-05T02:00:00.000Z";
const ID = depositItemId("seat-a", "d-1");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "owner-queue-blocker-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deposit(overrides: Partial<OwnerItemDeposit> = {}): OwnerItemDeposit {
  return { depositId: "d-1", asker: "seat-a", kind: "do", door: "two-way", summary: "Unblock the lane", context: "Nothing can merge.", ...overrides };
}

describe("a blocker on a deposit", () => {
  it("a deposit with a blocker round-trips since and blocks", async () => {
    const blocker = { since: new Date(Date.now() - 3_600_000).toISOString(), blocks: "lane alpha cannot merge" };
    await writeDeposit(root, deposit({ blocker }));

    const listed = (await readSpool(root)).items.find((item) => item.id === ID);
    expect(listed?.blocker).toEqual(blocker);
    expect(listed?.unblocksNow).toBe("lane alpha cannot merge");

    await withdrawDeposit(root, ID, { reason: "resolved", as: "seat-a", actor: "seat-a", now: NOW });
    expect(await readWithdrawal(root, ID)).toMatchObject({ reason: "resolved" });
    expect((await readSpool(root)).items.find((item) => item.id === ID)?.blocker).toEqual(blocker);
  });

  it("a deposit without a blocker still parses", () => {
    const filed = fromDeposit(deposit(), NOW);

    expect(filed).not.toHaveProperty("blocker");
    expect(filed.unblocksNow).toBeUndefined();
  });

  it("a blocker with an invalid since is refused", () => {
    const refused = (since: string): void => void fromDeposit(deposit({ blocker: { since, blocks: "lane alpha" } }), NOW);

    expect(() => refused("yesterday")).toThrow();
    expect(() => refused("2031-03-05T12:06:00.000Z")).toThrow(/future/);
    expect(() => refused("2031-01-01T00:00:00.000Z")).toThrow(/30 days/);
    expect(() => refused("2031-03-05T12:04:00.000Z")).not.toThrow();
  });

  it("a blocker on a review deposit is refused", () => {
    expect(() => fromDeposit(deposit({ kind: "review", blocker: { since: SINCE, blocks: "lane alpha" } }), NOW)).toThrow(/decide, approve or do/);
  });
});
