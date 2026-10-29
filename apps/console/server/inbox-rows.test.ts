import { describe, expect, it } from "vitest";
import { inboxReadCache, inboxRow, viewRows } from "./inbox-rows.js";
import type { InboxItem, InboxSources, WatchRow } from "./inbox-view.js";
import type { ShepherdSource } from "./shepherd.js";

const HEAVY = "a long synthetic section context. ".repeat(6_000);

function roundItem(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id, sources: [{ system: "round", ref: `heavy-r1#${id}` }], kind: "review", door: "two-way", summary: "Which ramp should ship by default?", context: HEAVY,
    options: [{ id: "staged", label: "Staged" }, { id: "flat", label: "Flat" }],
    recommended: { optionId: "staged", by: "synthetic-reviewer", confidence: 0.8, rationale: HEAVY, cite: HEAVY },
    keys: ["ask:heavy/q1"], personal: false, lens: "planning", unblocks: [], openedAt: "2026-10-10T01:00:00.000Z", status: "open",
    section: "blocking", evidence: "#/rounds/heavy-r1", action: { kind: "open-round", roundId: "heavy-r1" },
    ...overrides,
  };
}

describe("inboxRow", () => {
  it("keeps a heavy round's item to what the page renders", () => {
    const row = inboxRow(roundItem("q1"));

    expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(1_024);
    expect(row).toMatchObject({ summary: "Which ramp should ship by default?", recommended: { optionId: "staged", by: "synthetic-reviewer", confidence: 0.8 }, options: [{ id: "staged" }, { id: "flat" }] });
    expect(row).not.toHaveProperty("context");
    expect(row.recommended).not.toHaveProperty("rationale");
    expect(row.recommended).not.toHaveProperty("cite");
  });

  it("drops an item's anchors and pins", () => {
    const anchors = [{ path: "src/a.ts", line: 1 }] as unknown as InboxItem["anchors"];
    const pins = { repo: "example/repo", sha: "0".repeat(40) } as unknown as InboxItem["pins"];

    const row = inboxRow(roundItem("q1", { anchors, pins }));

    expect(row).not.toHaveProperty("anchors");
    expect(row).not.toHaveProperty("pins");
  });
});

describe("viewRows", () => {
  const items = [roundItem("q1"), roundItem("q2", { section: "planning" }), roundItem("q3", { section: "planning" })];

  it("counts planning items and leaves them out by default", () => {
    const view = viewRows(items, {});

    expect(view.planningCount).toBe(2);
    expect(view.items.map((row) => row.id)).toEqual(["q1"]);
  });

  it("lists planning items when asked for them", () => {
    expect(viewRows(items, { planning: true }).items.map((row) => row.id)).toEqual(["q1", "q2", "q3"]);
  });
});

describe("inboxReadCache", () => {
  function counted(): { sources: InboxSources; needsCalls: () => number; finishedCalls: () => number } {
    let needs = 0;
    let finished = 0;
    const shepherd = {
      list: (state: string) => {
        if (state === "finished") finished += 1;
        return Promise.resolve([] as WatchRow[]);
      },
    } as unknown as ShepherdSource;
    const factory = { list: () => Promise.resolve({ items: [], gaps: [`read ${++needs}`] }) };
    const sources = { factory, shepherd, rounds: { dir: "/synthetic/rounds" }, inbox: { dir: "/synthetic/inbox" }, now: () => 0 };
    return { sources, needsCalls: () => needs, finishedCalls: () => finished };
  }

  it("reads the factory and the finished runs once inside the fresh window", async () => {
    const { sources, needsCalls, finishedCalls } = counted();
    const cache = inboxReadCache(sources);

    await Promise.all([cache.factory!.list(), cache.finished.read()]);
    const again = await cache.factory!.list();
    await cache.finished.read();

    expect(again.gaps).toEqual(["read 1"]);
    expect([needsCalls(), finishedCalls()]).toEqual([1, 1]);
  });

  it("reads both again after an invalidate", async () => {
    const { sources, needsCalls, finishedCalls } = counted();
    const cache = inboxReadCache(sources);
    await Promise.all([cache.factory!.list(), cache.finished.read()]);

    cache.invalidate();
    const fresh = await cache.factory!.list();
    await cache.finished.read();

    expect(fresh.gaps).toEqual(["read 2"]);
    expect([needsCalls(), finishedCalls()]).toEqual([2, 2]);
  });

  it("offers no factory when none is configured", () => {
    const { sources } = counted();

    expect(inboxReadCache({ ...sources, factory: undefined }).factory).toBeUndefined();
  });
});
