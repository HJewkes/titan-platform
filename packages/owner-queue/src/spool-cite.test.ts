import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnerItemDeposit } from "./deposit.js";
import type { LocatorCite } from "./schema.js";
import { DepositCiteError, readSpool, writeDeposit, type SessionEventRef, type SessionEventTextSource } from "./spool.js";

const EVENT_TEXT = "The flat layout keeps   every read\nto one lookup, so it wins.";

let root: string;
let dir: string;
let asked: SessionEventRef[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "owner-queue-cite-"));
  dir = join(root, "deposits");
  asked = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const events: SessionEventTextSource = async (ref) => {
  asked.push(ref);
  return ref.session === "s-1" && ref.byteOffset === 120 && ref.byteLength === 64 ? EVENT_TEXT : null;
};

function cited(cite: string | LocatorCite): OwnerItemDeposit {
  return {
    depositId: "d-cite",
    asker: "agent-a",
    kind: "decide",
    door: "two-way",
    summary: "Pick a cache layout",
    context: "Two layouts fit the read path.",
    options: [
      { id: "flat", label: "Flat" },
      { id: "nested", label: "Nested" },
    ],
    recommended: { optionId: "flat", by: "decider", confidence: 0.7, cite },
  };
}

const locator = (quote: string, event = "120:64"): LocatorCite => ({ session: "s-1", event, quote });
const spoolFiles = async (): Promise<string[]> => readdir(dir).catch(() => []);

describe("writeDeposit with a locator cite", () => {
  it("refuses a quote the event does not hold, and writes nothing", async () => {
    const write = writeDeposit(dir, cited(locator("The nested layout keeps every read")), { events });

    await expect(write).rejects.toThrow(DepositCiteError);
    await expect(write).rejects.toThrow("does not match");
    expect(await spoolFiles()).toEqual([]);
  });

  it("files a quote re-wrapped over two lines, asking the source for the cited event", async () => {
    const result = await writeDeposit(dir, cited(locator("The flat layout keeps every\nread to one lookup")), { events });

    expect(result.created).toBe(true);
    expect(asked).toEqual([{ session: "s-1", byteOffset: 120, byteLength: 64 }]);
    expect((await readSpool(dir)).items[0]?.recommended?.cite).toEqual(locator("The flat layout keeps every\nread to one lookup"));
  });

  it("refuses an empty quote even though every text contains it", async () => {
    await expect(writeDeposit(dir, cited(locator("")), { events })).rejects.toThrow("the quote is empty");
    await expect(writeDeposit(dir, cited(locator(" \n ")), { events })).rejects.toThrow("the quote is empty");
    expect(await spoolFiles()).toEqual([]);
  });

  it("refuses an event the source cannot read", async () => {
    await expect(writeDeposit(dir, cited(locator("The flat layout", "999:64")), { events })).rejects.toThrow("could not be read");
    expect(await spoolFiles()).toEqual([]);
  });

  it("refuses a locator cite when there is no events source to check it", async () => {
    await expect(writeDeposit(dir, cited(locator("The flat layout")))).rejects.toThrow("no session event source");
    expect(await spoolFiles()).toEqual([]);
  });

  it("refuses an event that is not <byteOffset>:<byteLength> before asking the source", async () => {
    await expect(writeDeposit(dir, cited(locator("The flat layout", "120")), { events })).rejects.toThrow(/an event/);
    expect(asked).toEqual([]);
  });
});

describe("writeDeposit with a legacy cite", () => {
  it("files free text with or without an events source, and never asks it", async () => {
    expect((await writeDeposit(dir, cited("ledger:k-1"), { events })).created).toBe(true);
    expect((await writeDeposit(dir, { ...cited("ledger:k-2"), depositId: "d-plain" })).created).toBe(true);
    expect(asked).toEqual([]);
  });
});
