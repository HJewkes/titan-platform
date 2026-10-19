import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CONFIRM_TTL_MS, digestOf, MAX_PREPARED, outcomeFile, preparedStore, readSettled, recordOnce, settleOutcome, writeOnce, type Prepared } from "./owner-tap.js";

const CONFIRM_A = "a".repeat(64);
const CONFIRM_B = "b".repeat(64);
const READ_AT = "2026-10-10T06:00:00.000Z";
const RECORD = z.looseObject({ kind: z.string() });

let dir: string;
let clock: number;
const now = (): number => clock;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-owner-tap-"));
  clock = Date.parse(READ_AT);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (key: string): Prepared => ({ key, readAt: READ_AT, expiresAt: clock + CONFIRM_TTL_MS });

describe("writeOnce", () => {
  it("refuses a second write and leaves the first bytes in place", async () => {
    const file = path.join(dir, "record.json");

    const first = await writeOnce(file, "first\n");
    const second = await writeOnce(file, "second\n");

    expect([first, second]).toEqual([true, false]);
    expect(await readFile(file, "utf8")).toBe("first\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("preparedStore", () => {
  it("finds a confirm until its expiry and not at the expiry instant", () => {
    const store = preparedStore(now);
    store.remember(CONFIRM_A, entry("item-1"));

    clock += CONFIRM_TTL_MS - 1;
    const justBefore = store.lookup(CONFIRM_A, "item-1");
    clock += 1;
    const atExpiry = store.lookup(CONFIRM_A, "item-1");

    expect(justBefore?.key).toBe("item-1");
    expect(atExpiry).toBeUndefined();
  });

  it("does not find a confirm under a different target key", () => {
    const store = preparedStore(now);
    store.remember(CONFIRM_A, entry("item-1"));

    expect(store.lookup(CONFIRM_A, "item-2")).toBeUndefined();
  });

  it("drops the oldest confirm once past the cap", () => {
    const store = preparedStore(now);
    store.remember(CONFIRM_A, entry("first"));
    for (let index = 0; index < MAX_PREPARED; index += 1) store.remember(index.toString(16).padStart(64, "0"), entry(`item-${index}`));

    expect(store.lookup(CONFIRM_A, "first")).toBeUndefined();
    expect(store.lookup((MAX_PREPARED - 1).toString(16).padStart(64, "0"), `item-${MAX_PREPARED - 1}`)).toBeDefined();
  });
});

describe("digestOf", () => {
  it("changes when any bound part changes", () => {
    const base = digestOf(["item-1", { effect: "merge" }, READ_AT]);

    expect(digestOf(["item-1", { effect: "merge" }, READ_AT])).toBe(base);
    expect(digestOf(["item-1", { effect: "release" }, READ_AT])).not.toBe(base);
    expect(digestOf(["item-1", { effect: "merge" }, "2026-10-10T06:00:01.000Z"])).not.toBe(base);
  });
});

describe("recordOnce", () => {
  const spec = (store: ReturnType<typeof preparedStore>, write: (file: string) => Promise<void>) => ({ store, actionsDir: dir, confirm: CONFIRM_A, key: "item-1", stale: "stale confirm", schema: RECORD, write });

  it("refuses a confirm the store does not hold and writes nothing", async () => {
    let writes = 0;

    const attempt = recordOnce(spec(preparedStore(now), async () => void (writes += 1)));

    await expect(attempt).rejects.toThrow("stale confirm");
    expect(writes).toBe(0);
  });

  it("writes the record on the first call and replays the same record without writing again", async () => {
    const store = preparedStore(now);
    store.remember(CONFIRM_A, entry("item-1"));
    let writes = 0;
    const write = async (file: string) => {
      writes += 1;
      await writeFile(file, JSON.stringify({ kind: `write-${writes}` }));
    };

    const first = await recordOnce(spec(store, write));
    const replay = await recordOnce(spec(store, write));

    expect(writes).toBe(1);
    expect(first.file).toBe(path.join(dir, `${CONFIRM_A}.json`));
    expect(replay.record).toEqual({ kind: "write-1" });
  });
});

describe("settleOutcome", () => {
  const file = (): string => path.join(dir, `${CONFIRM_B}.json`);

  it("writes nothing for an unreachable or unmounted factory, so the confirm can be retried", async () => {
    const unreachable = await settleOutcome(file(), { status: "unreachable" }, READ_AT);
    const off = await settleOutcome(file(), { status: "off" }, READ_AT);

    expect([unreachable, off]).toEqual([false, false]);
    expect(await readSettled(file())).toBeUndefined();
  });

  it("writes the first settled outcome once and keeps it against a later one", async () => {
    const released = { status: "released", runId: "run-1" };

    const first = await settleOutcome(file(), released, READ_AT);
    const second = await settleOutcome(file(), { status: "gone" }, READ_AT);

    expect([first, second]).toEqual([true, false]);
    expect(await readSettled(file())).toEqual({ status: "released", runId: "run-1", at: READ_AT });
    expect(outcomeFile(file())).toBe(path.join(dir, `${CONFIRM_B}.outcome.json`));
  });
});
