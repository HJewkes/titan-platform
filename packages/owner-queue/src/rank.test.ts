import { describe, expect, it } from "vitest";
import { item } from "./test-fixtures.js";
import { rank } from "./rank.js";

const ids = (items: { id: string }[]) => items.map((each) => each.id);

describe("rank", () => {
  it("puts one-way and blocking owner-now items before a costlier two-way item", () => {
    const costly = item({ id: "costly", unblocks: ["task:PRJ1-1", "task:PRJ1-2", "task:PRJ1-3"] });
    const oneWay = item({ id: "one-way", door: "one-way" });
    const blockingNow = item({
      id: "blocking-now",
      lens: "blocking-merge",
      route: { target: "owner-now", reason: "example", shadow: true },
      openedAt: "2026-01-03T00:00:00Z",
    });

    expect(ids(rank([costly, blockingNow, oneWay]))).toEqual(["one-way", "blocking-now", "costly"]);
  });

  it("does not lift a blocking item that is routed to the queue", () => {
    const queued = item({ id: "queued", lens: "blocking-agent", route: { target: "owner-queue", reason: "example", shadow: true } });
    const costly = item({ id: "costly", unblocks: ["run:r-1"] });

    expect(ids(rank([queued, costly]))).toEqual(["costly", "queued"]);
  });

  it("orders by cost of waiting, then oldest first", () => {
    const newer = item({ id: "newer", openedAt: "2026-01-02T00:00:00Z" });
    const older = item({ id: "older", openedAt: "2026-01-01T00:00:00+00:00" });
    const costly = item({ id: "costly", unblocks: ["run:r-1"], openedAt: "2026-01-05T00:00:00Z" });

    expect(ids(rank([newer, older, costly]))).toEqual(["costly", "older", "newer"]);
  });

  it("groups full ties by initiative, items with no initiative last, then by id", () => {
    const items = [
      item({ id: "c", initiative: "init-b" }),
      item({ id: "e" }),
      item({ id: "b", initiative: "init-a" }),
      item({ id: "d", initiative: "init-b" }),
      item({ id: "a", initiative: "init-a" }),
    ];

    expect(ids(rank(items))).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids(rank([...items].reverse()))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not reorder its input", () => {
    const items = [item({ id: "b" }), item({ id: "a" })];

    rank(items);

    expect(ids(items)).toEqual(["b", "a"]);
  });
});
