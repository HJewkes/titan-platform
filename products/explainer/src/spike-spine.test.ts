import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ledgerRows } from "./lint-ledger.js";
import { migrateSpike } from "./migrate.js";
import { fromScriptV1, labelKey } from "./pace-items.js";
import { invariantSeatRow, journeyOrderRow } from "./lint-spine.js";
import { contrastBeats, parseSpine } from "./spine-schema.js";
import { V4_SPINE_PATH, v4FullScript } from "./spike-fixtures.test-helpers.js";

const spine = parseSpine(readFileSync(V4_SPINE_PATH, "utf8"));
const script = migrateSpike(v4FullScript());
const beats = fromScriptV1(script);
const listBeats = beats.filter((b) => b.items.filter((i) => i.source === "cue" && i.role === "item").length >= 2);

describe("the planner-written v4 spine", () => {
  it("parses with the journey, architecture, constraints, ledger and chapters filled", () => {
    expect(spine.id).toBe("redesign-explainer-v4");
    expect(spine.journey.length).toBeGreaterThan(0);
    expect(spine.architecture.length).toBeGreaterThan(0);
    expect(spine.constraints.length).toBeGreaterThan(0);
    expect(spine.ledger.length).toBeGreaterThan(0);
    expect(spine.chapters.length).toBeGreaterThan(0);
  });

  it("declares the removal cards and the split-map merge-up beat a contrast", () => {
    expect([...contrastBeats(spine)]).toEqual(["r5-2-mergeup", "r7-1-carry", "r7-3-caps", "r7-4b-score", "r7-4c-replay"]);
  });

  it("declares a kind for every entry of every list beat, defined at or before that beat", () => {
    const position = new Map(beats.map((b, i) => [b.id, i]));
    const ledger = new Map(spine.ledger.map((row) => [labelKey(row.item), row]));
    const undeclared = listBeats.flatMap((beat) =>
      beat.items
        .filter((i) => i.source === "cue" && i.role === "item")
        .filter((i) => {
          const defined = position.get(ledger.get(labelKey(i.label))?.definedIn ?? "");
          return defined === undefined || defined > position.get(beat.id)!;
        })
        .map((i) => `${beat.id}: ${i.label}`),
    );

    expect(listBeats.length).toBeGreaterThan(20);
    expect(undeclared).toEqual([]);
  });

  it("passes the order, seat, defined-before-use and one-kind-a-list lints", () => {
    const rows = ledgerRows(beats, spine, true);

    expect(journeyOrderRow(spine).pass).toBe(true);
    expect(invariantSeatRow(spine, script.video.invariants ?? []).pass).toBe(true);
    expect(rows.find((r) => r.check_id === "Q-E17")?.pass).toBe(true);
    expect(rows.find((r) => r.check_id === "Q-E16")).toMatchObject({ pass: true, detail_beats: [] });
  });
});
