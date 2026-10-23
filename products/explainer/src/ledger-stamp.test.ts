import { describe, expect, it } from "vitest";
import { runL0 } from "./eval-l0.js";
import { repairHint } from "./l0-repair-hints.js";
import { ledgerCheck } from "./lint-ledger.js";
import { stampLedgerTerms } from "./ledger-stamp.js";
import type { ScriptV1 } from "./script-schema.js";
import type { SpineLedgerRow, SpineV1 } from "./spine-schema.js";
import { GOOD_BEATS, tour, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

const entry = (item: string, definedIn: string): SpineLedgerRow => ({ item, kind: "concept", definedIn, reusedIn: [] });

const spineOf = (ledger: SpineLedgerRow[]): SpineV1 => ({
  schema: "spine/v1",
  id: "fixture",
  journey: [{ n: 1, step: "Choose", what: "a task is picked", why: "capacity is finite", invariant: null, breaksToday: null }],
  architecture: [{ part: "Broker", carries: ["1"], mechanism: null, constraint: null }],
  constraints: [],
  ledger,
  chapters: [],
  shapes: [],
});

const LEDGER = [entry("PR 101", "ch2"), entry("TP-7", "ch2"), entry("TP-9", "ch1")];

const withSpoken = (id: string, spoken: string, extra: Record<string, unknown> = {}, base: BeatSpec[] = GOOD_BEATS): BeatSpec[] =>
  base.map(([beatId, chapter, fn, was, more]) => (beatId === id ? [beatId, chapter, fn, spoken, { ...more, ...extra }] : [beatId, chapter, fn, was, more]));

const pinned = (text: string) => ({ visual: { assertion: "The desk refuses unknown parcels", job: "map", map_state: { level: "components", visible: ["desk"], pins: [{ anchor: "desk", text, atCue: "desk" }] } } });

const termsOf = (script: ScriptV1, id: string): string[] => script.beats.find((b) => b.id === id)!.new_terms;

const q17 = (script: ScriptV1, spine: SpineV1) => runL0(script, undefined, [ledgerCheck], undefined, spine).find((r) => r.check_id === "Q-E17")!;

describe("stampLedgerTerms", () => {
  // Mutation: dropping the chapter test stamps an item on a beat that names it before its chapter defines it.
  it("stamps a ch2 ledger item named in ch2 with empty new_terms, and records the stamp", () => {
    const script = tour(withSpoken("w1", "So PR 101 sends every scan to the desk server."));

    const stamped = stampLedgerTerms(script, spineOf(LEDGER));

    expect(termsOf(stamped.script, "w1")).toEqual(["PR 101"]);
    expect(stamped.stamps).toEqual([{ beat: "w1", term: "PR 101" }]);
  });

  it("stamps only the first beat that names the item", () => {
    const script = tour(withSpoken("w2", "PR 101 holds each scan until the ledger confirms.", {}, withSpoken("w1", "So PR 101 starts the scan.")));

    const stamped = stampLedgerTerms(script, spineOf(LEDGER));

    expect(stamped.stamps).toEqual([{ beat: "w1", term: "PR 101" }]);
  });

  it("leaves an item named in ch1 that the ledger defines in ch2 unstamped", () => {
    const script = tour(withSpoken("h1", "A courier asks about PR 101, but the desk refuses."));

    const stamped = stampLedgerTerms(script, spineOf(LEDGER));

    expect(stamped.stamps).toEqual([]);
    expect(stamped.script).toBe(script);
  });

  it("keeps a term the model already declared, in any case", () => {
    const script = tour(withSpoken("w1", "So PR 101 sends every scan.", { new_terms: ["pr 101"] }));

    expect(stampLedgerTerms(script, spineOf(LEDGER)).stamps).toEqual([]);
  });

  it("leaves names the ledger does not list, and handles that only share a prefix, untouched", () => {
    const script = tour(withSpoken("w1", "So PR 1011 and the Scanner app send every scan to the desk server."));

    const stamped = stampLedgerTerms(script, spineOf(LEDGER));

    expect(stamped.stamps).toEqual([]);
    expect(termsOf(stamped.script, "w1")).toEqual([]);
  });
});

describe("Q-E17 on a ledger item named too early, or a pin the ledger does not list", () => {
  it("fails a ledger item cited in ch1, and the hint names the item and its chapter", () => {
    const script = tour(withSpoken("h1", "A courier asks about PR 101, but the desk refuses.", { ...pinned("PR 101") }));
    const row = q17(script, spineOf(LEDGER));

    expect(row).toMatchObject({ pass: false, detail_beats: ["h1"] });
    expect(repairHint(row, script, undefined, spineOf(LEDGER))).toBe('h1 shows "PR 101" before ch2, where the ledger defines it; move it to ch2 or drop it');
  });

  it("names each unledgered pin, its beat, and the ledger handles that chapter may use", () => {
    const script = tour(withSpoken("w1", "So PR 101 sends every scan to the desk server.", { ...pinned("Times out at 10 s on slow CI") }));
    const row = q17(script, spineOf(LEDGER));

    expect(repairHint(row, script, undefined, spineOf(LEDGER))).toBe(
      'w1 shows "Times out at 10 s on slow CI" (pin), not in the spine ledger; name a ledger item the chapter may use ("PR 101", "TP-7", "TP-9") or drop it',
    );
  });

  it("passes the same beat once the pin is rewritten to name a ledger item", () => {
    const script = tour(withSpoken("w1", "So PR 101 sends every scan to the desk server.", { ...pinned("PR 101") }));

    expect(q17(script, spineOf(LEDGER)).pass).toBe(true);
  });

  it("gives no hint without a spine", () => {
    const script = tour(withSpoken("w1", "So PR 101 sends every scan to the desk server.", { ...pinned("Times out") }));

    expect(repairHint(q17(script, spineOf(LEDGER)), script)).toBeUndefined();
  });
});
