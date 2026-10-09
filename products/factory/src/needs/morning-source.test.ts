import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerItemSchema } from "@titan-design/owner-queue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MORNING_COUNT, SEATS, seatQueueFile } from "../test-support/owner-queue-10-05.js";
import { createMorningSource, morningQueuesDir } from "./morning-source.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morning-source-"));
  for (const seat of SEATS) writeFileSync(join(dir, `${seat}.md`), seatQueueFile(seat));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createMorningSource", () => {
  it("opens every seat's Morning items as schema-valid owner items", async () => {
    const items = await createMorningSource({ dir }).open();

    expect(items).toHaveLength(MORNING_COUNT);
    expect(items.every((item) => ownerItemSchema.safeParse(item).success)).toBe(true);
    expect(items[0]!.id).toBe("morning:seat-a:1");
  });

  it("reads only the named seats, in their order, and skips a seat with no file", async () => {
    const items = await createMorningSource({ dir, seats: ["seat-c", "seat-x"] }).open();

    expect(new Set(items.map((item) => item.seat))).toEqual(new Set(["seat-c"]));
  });

  it("refuses an answer, which still goes through the seat", async () => {
    const result = await createMorningSource({ dir }).resolve("seat-a:1", { by: { class: "owner", id: "owner", channel: "test" }, at: "2026-10-05T09:00:00Z" });

    expect(result.ok).toBe(false);
  });

  it("tails a resync when a queue file changes", async () => {
    const source = createMorningSource({ dir, seats: ["seat-a"], pollMs: 5 });
    const controller = new AbortController();
    const events = source.tail("stale-cursor", controller.signal)[Symbol.asyncIterator]();

    const first = await events.next();
    controller.abort();

    expect(first.value).toMatchObject({ type: "resync" });
  });
});

describe("morningQueuesDir", () => {
  it("roots the queues at ACTIVE_ROOT", () => {
    expect(morningQueuesDir({ ACTIVE_ROOT: "/srv/aw" })).toBe("/srv/aw/claude-channels/sources/autonomy/queues");
  });
});
