import type { Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempTree, VALID_WATCHLIST, writeSeenTree, type TempTree } from "./fixtures.test-helpers.js";
import { importSeen } from "./seen-import.js";
import { getVideo, openScoutDb } from "./store.js";
import { parseWatchlist } from "./watchlist.js";

const watchlist = parseWatchlist(VALID_WATCHLIST, "watchlist.yml");
const NOW = () => new Date("2026-10-28T12:00:00Z");

let tree: TempTree;
let db: Db;

beforeEach(() => {
  tree = tempTree();
  db = openScoutDb(":memory:");
});
afterEach(() => {
  db.close();
  tree.cleanup();
});

describe("seen import", () => {
  it("gives each history id its furthest state and counts them", () => {
    writeSeenTree(tree);

    const report = importSeen(db, tree.root, watchlist, NOW);

    expect(report.sources).toEqual([
      { name: "inventory", present: true, ids: 5 },
      { name: "scores", present: true, ids: 3 },
      { name: "watch-later", present: true, ids: 3 },
      { name: "out", present: true, ids: 2 },
    ]);
    expect({ inserted: report.inserted, upgraded: report.upgraded, unchanged: report.unchanged }).toEqual({ inserted: 8, upgraded: 0, unchanged: 0 });
    expect(report.states).toEqual({ mined: 1, scored: 3, seen: 3, transcribed: 1 });
  });

  it("adds nothing when rerun on the same files", () => {
    writeSeenTree(tree);
    importSeen(db, tree.root, watchlist, NOW);

    const rerun = importSeen(db, tree.root, watchlist, NOW);

    expect({ inserted: rerun.inserted, upgraded: rerun.upgraded, unchanged: rerun.unchanged }).toEqual({ inserted: 0, upgraded: 0, unchanged: 8 });
    expect(rerun.states).toEqual({ mined: 1, scored: 3, seen: 3, transcribed: 1 });
  });

  it("moves a video forward when a later rerun finds more history for it", () => {
    writeSeenTree(tree);
    importSeen(db, tree.root, watchlist, NOW);
    tree.write("watch-later/facts/wwwwwwwww02.md", "synthetic facts\n");

    const rerun = importSeen(db, tree.root, watchlist, NOW);

    expect(rerun.upgraded).toBe(1);
    expect(getVideo(db, "wwwwwwwww02")?.state).toBe("mined");
  });

  it("keeps the merged card over a batch card and maps channels to watch-list keys", () => {
    writeSeenTree(tree);

    importSeen(db, tree.root, watchlist, NOW);

    const two = getVideo(db, "aaaaaaaaa02")!;
    expect(JSON.parse(two.card!).total).toBe(9);
    expect(two).toMatchObject({ source: "confTalks", duration: 900, published: "2026-09-29", detected_at: "2026-10-28T12:00:00.000Z" });
    expect(getVideo(db, "aaaaaaaaa04")?.source).toBe("vendor");
    expect(getVideo(db, "wwwwwwwww01")?.source).toBe("confTalks");
    expect(getVideo(db, "aaaaaaaaa03")?.source).toBe("Unlisted Person");
  });

  it("reports missing history files instead of failing", () => {
    const report = importSeen(db, tree.root, watchlist, NOW);

    expect(report.sources.every((s) => !s.present)).toBe(true);
    expect(report.inserted).toBe(0);
  });

  it("names the line of a malformed inventory row", () => {
    tree.write("ai-channels-2026-10/inventory.jsonl", '{"id":"aaaaaaaaa01"}\n{broken\n');

    expect(() => importSeen(db, tree.root, watchlist, NOW)).toThrow(/inventory\.jsonl:2:/);
  });
});
