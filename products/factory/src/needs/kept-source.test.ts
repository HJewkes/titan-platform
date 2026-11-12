import type { OwnerItem, QueueSource, ResolveResult } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import { decisionTask } from "../test-support/owner-queue-10-05.js";
import { decisionTaskItem } from "./active-work-source.js";
import { keptSource } from "./kept-source.js";

const WINDOW = { freshMs: 1_000, staleMs: 10_000 };

interface FakeSource {
  source: QueueSource;
  reads: () => number;
  /** The next open() answers these items, or fails when given an Error. */
  answer: (next: OwnerItem[] | Error) => void;
  /** Holds open() until release() is called. */
  hold: () => { release: () => void };
}

function fakeSource(resolveResult: ResolveResult = { ok: true }): FakeSource {
  let reads = 0;
  let next: OwnerItem[] | Error = [];
  let gate: Promise<void> = Promise.resolve();
  const source: QueueSource = {
    system: "active-work",
    open: async () => {
      reads += 1;
      const answer = next;
      await gate;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    tail: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
    resolve: async () => resolveResult,
  };
  return {
    source,
    reads: () => reads,
    answer: (items) => void (next = items),
    hold: () => {
      let release = (): void => undefined;
      gate = new Promise((done) => (release = done));
      return { release: () => { gate = Promise.resolve(); release(); } };
    },
  };
}

const task = (n: number): OwnerItem => decisionTaskItem(decisionTask(n), false);
const ids = (items: OwnerItem[]): string[] => items.map((item) => item.id);
const ANSWER = { optionId: "ok", by: { class: "human", id: "owner", channel: "console" }, at: "2026-10-05T00:00:00.000Z" };
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe("a kept slow source", () => {
  it("serves the kept read inside the fresh window without reading again", async () => {
    let now = 0;
    const fake = fakeSource();
    fake.answer([task(1)]);
    const kept = keptSource(fake.source, { ...WINDOW, now: () => now });

    await kept.open();
    fake.answer([task(2)]);
    now = 999;
    const second = await kept.open();

    expect(ids(second)).toEqual([task(1).id]);
    expect(fake.reads()).toBe(1);
  });

  it("serves the kept read past the fresh window while one refresh runs behind", async () => {
    let now = 0;
    const fake = fakeSource();
    fake.answer([task(1)]);
    const kept = keptSource(fake.source, { ...WINDOW, now: () => now });
    await kept.open();

    fake.answer([task(2)]);
    now = 1_000;
    const held = fake.hold();
    const served = await Promise.all([kept.open(), kept.open()]);
    held.release();
    await settle();
    const refreshed = await kept.open();

    expect(served.map(ids)).toEqual([[task(1).id], [task(1).id]]);
    expect(fake.reads()).toBe(2);
    expect(ids(refreshed)).toEqual([task(2).id]);
  });

  it("waits on a live read once the kept read is past the stale limit", async () => {
    let now = 0;
    const fake = fakeSource();
    fake.answer([task(1)]);
    const kept = keptSource(fake.source, { ...WINDOW, now: () => now });
    await kept.open();

    fake.answer([task(2)]);
    now = 10_000;
    const read = await kept.open();

    expect(ids(read)).toEqual([task(2).id]);
  });

  it("never keeps a failed read", async () => {
    const fake = fakeSource();
    const kept = keptSource(fake.source, { ...WINDOW, now: () => 0 });

    fake.answer(new Error("active-work: unreachable"));
    const failed = kept.open();
    await expect(failed).rejects.toThrow("unreachable");
    fake.answer([task(1)]);
    const read = await kept.open();

    expect(ids(read)).toEqual([task(1).id]);
    expect(fake.reads()).toBe(2);
  });

  it("drops the kept read on an accepted write, including a read that began before it", async () => {
    const fake = fakeSource({ ok: true });
    fake.answer([task(1)]);
    const kept = keptSource(fake.source, { ...WINDOW, now: () => 0 });
    await kept.open();

    const held = fake.hold();
    const before = keptSource(fake.source, { ...WINDOW, now: () => 0 });
    const racing = before.open();
    await before.resolve("demo/D-1001", ANSWER);
    held.release();
    await racing;
    await kept.resolve("demo/D-1001", ANSWER);
    fake.answer([task(2)]);
    const afterWrite = await kept.open();
    const afterRace = await before.open();

    expect(ids(afterWrite)).toEqual([task(2).id]);
    expect(ids(afterRace)).toEqual([task(2).id]);
  });
});
