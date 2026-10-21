import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coldQuestions } from "./eval-cold.js";
import { compareTimed, OVERLOAD_ITEM, prepareTimedSession, recordTimedSession, ownerSessionDir, type OwnerRow, type ProbeRow } from "./eval-owner.js";
import { benchLayout, readTsv } from "./eval-store.js";
import { fromSpikeScript } from "./spike-script.js";
import { readTiming } from "./timing.js";
import { v4Durations, v4Script } from "./spike-fixtures.test-helpers.js";

const bench = () => benchLayout(mkdtempSync(join(tmpdir(), "explainer-timed-")));
const version = { config_id: "v4/spike", script_sha: "0123456789ab" };
const track = () => fromSpikeScript(v4Script(), readTiming(v4Durations())).beats;
const options = { date: "2026-10-20", heldOut: false };
const sheet = (dir: string, chapter: string): string => readFileSync(join(dir, `questions-${chapter}.md`), "utf8");

describe("timed session preparation", () => {
  it("asks each chapter exactly the cold probe's questions, then the overload row", () => {
    const layout = bench();
    const beats = track();

    const chapters = prepareTimedSession(layout, "t1", version, beats);

    const dir = ownerSessionDir(layout, "t1");
    expect(readdirSync(dir).filter((f) => f.startsWith("questions-")).length).toBe(chapters.length);
    for (const chapter of chapters) {
      const expected = coldQuestions(beats.filter((b) => b.chapter === chapter));
      expect(expected.length).toBeGreaterThan(0);
      for (const q of expected) expect(sheet(dir, chapter)).toContain(q.text);
      expect(sheet(dir, chapter)).toContain(`- ${OVERLOAD_ITEM}: How overloaded`);
    }
  });

  it("builds its questions from the item track, not from new_terms, which the v4 fixture lacks", () => {
    const layout = bench();
    const beats = track();
    expect(beats.every((b) => b.newItems.length >= 0)).toBe(true);

    const [first] = prepareTimedSession(layout, "t2", version, beats, [beats[0]!.chapter]);

    const asked = [...sheet(ownerSessionDir(layout, "t2"), first!).matchAll(/^- (what-why):/gm)];
    expect(asked.length).toBe(beats.filter((b) => b.chapter === first).flatMap((b) => b.newItems).length);
    expect(asked.length).toBeGreaterThan(0);
  });

  it("refuses a session that already exists and a chapter list that selects nothing", () => {
    const layout = bench();
    prepareTimedSession(layout, "t3", version, track());

    expect(() => prepareTimedSession(layout, "t3", version, track())).toThrow(/already exists/);
    expect(() => prepareTimedSession(layout, "t4", version, track(), ["nope"])).toThrow(/at least one chapter/);
  });
});

describe("timed session recording", () => {
  it("writes owner.tsv rows scoped timed:<chapter> before the key opens", () => {
    const layout = bench();
    const [chapter] = prepareTimedSession(layout, "t5", version, track());
    const dir = ownerSessionDir(layout, "t5");
    expect(readdirSync(dir)).not.toContain("key.json");

    recordTimedSession(layout, "t5", [{ chapter: chapter!, item: OVERLOAD_ITEM, value: "4" }, { chapter: chapter!, item: "what-why:x", value: "2" }], options);

    const rows = readTsv(join(layout.evals, "owner.tsv"));
    expect(rows.map((r) => r.scope)).toEqual([`timed:${chapter}`, `timed:${chapter}`]);
    expect(rows[0]).toMatchObject({ config_id: version.config_id, script_sha: version.script_sha, item: OVERLOAD_ITEM, value: "4" });
    expect(readdirSync(dir)).toContain("key.json");
  });

  it("writes nothing and keeps the key sealed when an answer is out of range", () => {
    const layout = bench();
    prepareTimedSession(layout, "t6", version, track());

    expect(() => recordTimedSession(layout, "t6", [{ chapter: "c", item: OVERLOAD_ITEM, value: "0" }], options)).toThrow(/one of 1, 2, 3, 4, 5/);
    expect(() => recordTimedSession(layout, "t6", [{ chapter: "c", item: "what-why:x", value: "3" }], options)).toThrow(/one of 0, 1, 2/);
    expect(readdirSync(ownerSessionDir(layout, "t6"))).not.toContain("key.json");
  });
});

describe("timed comparison", () => {
  const probe: ProbeRow[] = [
    { chapter: "ch1", kind: "what-why", item: "a", score: 2 },
    { chapter: "ch1", kind: "what-why", item: "b", score: 0 },
    { chapter: "ch2", kind: "what-why", item: "c", score: 0 },
    { chapter: "ch2", kind: "invariant", item: "d", score: 0 },
  ];
  const row = (chapter: string, item: string, value: string): OwnerRow => ({
    date: "2026-10-20", session: "t", held_out: "n", config_id: "c", script_sha: "s", scope: `timed:${chapter}`, item, value, note: "", blind_key_ref: "k",
  });
  const human = [
    row("ch1", "what-why:a", "1"),
    row("ch1", "what-why:b", "1"),
    row("ch1", OVERLOAD_ITEM, "1"),
    row("ch2", "what-why:c", "0"),
    row("ch2", "invariant:d", "0"),
    row("ch2", OVERLOAD_ITEM, "5"),
  ];

  it("reports agreement per item, counting 1 and 2 alike as conveyed", () => {
    const result = compareTimed(probe, human);

    expect(result.items.map((i) => [i.item, i.agree])).toEqual([
      ["what-why:a", true],
      ["what-why:b", false],
      ["what-why:c", true],
      ["invariant:d", true],
    ]);
    expect(result.agreement).toBe(0.75);
    expect(result.chapters.map((c) => [c.chapter, c.agreement, c.overload])).toEqual([["ch1", 0.5, 1], ["ch2", 1, 5]]);
  });

  it("correlates overload with the probe's undefined share across chapters", () => {
    expect(compareTimed(probe, human).overload_correlation).toBeCloseTo(1);
  });

  it("leaves out items only one side rated and non-timed rows", () => {
    const result = compareTimed(probe, [row("ch1", "what-why:a", "2"), { ...row("ch1", "what-why:b", "0"), scope: "ch1" }]);

    expect(result.items.map((i) => i.item)).toEqual(["what-why:a"]);
    expect(result.overload_correlation).toBeNull();
  });
});
