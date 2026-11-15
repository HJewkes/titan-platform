import { WatermarkTable, openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDeltas, reflectSession, type ReflectInput } from "./reflect.js";
import { DEFAULT_MEMORY_TABLES, memoryMigration } from "./schema.js";
import { PlaybookStore } from "./store.js";

describe("parseDeltas", () => {
  it("rejects non-arrays and invalid items with a reason, keeps the rest", () => {
    const rejected: { iteration: number; index: number; reason: string }[] = [];
    expect(parseDeltas({ not: "an array" }, new Set(), 1, rejected)).toEqual([]);
    const deltas = parseDeltas([{ type: "add", content: "x" }, { type: "helpful" }, { type: "nope" }], new Set(), 2, rejected);
    expect(deltas).toEqual([expect.objectContaining({ type: "add", content: "x", category: "general", tags: [] })]);
    expect(rejected.map((r) => [r.iteration, r.index])).toEqual([[1, -1], [2, 1], [2, 2]]);
    expect(rejected[1]?.reason).toContain("bulletId");
  });

  it("drops deltas already seen in earlier iterations", () => {
    const seen = new Set<string>();
    expect(parseDeltas([{ type: "add", content: "Use pnpm" }], seen, 1, [])).toHaveLength(1);
    expect(parseDeltas([{ type: "add", content: "use  pnpm" }, { type: "add", content: "new" }], seen, 2, [])).toHaveLength(1);
  });
});

describe("reflectSession", () => {
  let db: Db;
  let store: PlaybookStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db, [memoryMigration(1)]);
    store = new PlaybookStore(db);
  });

  afterEach(() => db.close());

  it("iterates until the reflector has nothing new, then curates with the session's provenance", async () => {
    const inputs: ReflectInput[] = [];
    const reflector = async (input: ReflectInput) => {
      inputs.push(input);
      if (input.iteration === 1) return [{ type: "add", content: "Pin the npm major in release jobs" }];
      if (input.iteration === 2) return [{ type: "add", content: "Pin the npm major in release jobs" }, { type: "add", content: "Fetch full history for changeset status" }];
      return [];
    };
    const watermark = new WatermarkTable(db, { name: DEFAULT_MEMORY_TABLES.watermark });
    const result = await reflectSession({ store, watermark }, { sessionRef: "session:s9", diary: "release fixes", byteOffset: 777 }, reflector);
    expect(result.iterations).toBe(3);
    expect(result.deltas).toHaveLength(2);
    expect(result.report.added).toHaveLength(2);
    expect(store.list().map((b) => b.sourceSessions)).toEqual([[{ sessionRef: "session:s9", byteOffset: 777 }], [{ sessionRef: "session:s9", byteOffset: 777 }]]);
    expect(inputs[1]?.priorDeltas).toHaveLength(1);
    expect(inputs[2]?.bullets).toEqual([]);
    expect(watermark.get("session:s9")).toMatchObject({ lastOffset: 777, status: "ok" });
  });

  it("stops at the delta cap", async () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    const reflector = async () => words.map((word) => ({ type: "add", content: `Always ${word} first` }));
    const result = await reflectSession({ store }, { sessionRef: "session:s1", diary: "" }, reflector, { maxDeltas: 4, maxIterations: 5 });
    expect(result.deltas).toHaveLength(4);
    expect(result.iterations).toBe(1);
    expect(store.list()).toHaveLength(4);
  });

  describe("bullets sent to the reflector", () => {
    const sentBullets = async (diary: string, options: { maxBullets?: number } = {}) => {
      const inputs: ReflectInput[] = [];
      await reflectSession({ store }, { sessionRef: "session:s2", diary }, async (input) => {
        inputs.push(input);
        return [];
      }, options);
      return inputs[0]?.bullets.map((b) => b.content);
    };

    it("sends only the bullet that shares words with the diary", async () => {
      store.add({ content: "Pin the npm major in release jobs" });
      store.add({ content: "Prefer small commits" });
      store.add({ content: "Name branches by type" });
      expect(await sentBullets("fixing the release workflow")).toEqual(["Pin the npm major in release jobs"]);
    });

    it("keeps the higher-scoring bullet when maxBullets is 1", async () => {
      store.add({ content: "Run the release check" });
      store.add({ content: "Run the release check before the npm release" });
      expect(await sentBullets("npm release", { maxBullets: 1 })).toEqual(["Run the release check before the npm release"]);
    });

    it("sends an empty list when the diary matches nothing", async () => {
      store.add({ content: "Pin the npm major in release jobs" });
      expect(await sentBullets("zebra quartz")).toEqual([]);
    });
  });

  it("surfaces rejected output instead of throwing", async () => {
    const result = await reflectSession({ store }, { sessionRef: "session:s1", diary: "" }, async () => "garbage");
    expect(result.rejected).toEqual([{ iteration: 1, index: -1, reason: "reflector did not return an array" }]);
    expect(result.deltas).toEqual([]);
  });
});
