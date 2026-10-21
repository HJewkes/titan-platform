import { describe, expect, it } from "vitest";
import { L0_CHECKS, runL0 } from "./eval-l0.js";
import { ledgerCheck, ledgerRows } from "./lint-ledger.js";
import { buildPaceBeats, type PaceSourceBeat } from "./pace-items.js";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import type { SpineLedgerRow, SpineV1 } from "./spine-schema.js";

const source = (id: string, labels: readonly string[], kind = "job"): PaceSourceBeat => ({
  id,
  chapter: "ch1",
  fn: "WHAT",
  spoken: "word ".repeat(40),
  plannedS: 20,
  mapBeside: false,
  cues: labels.map((label) => ({ target: `${kind}:${label}` })),
  titles: [],
  reveals: [],
  pins: [],
  cards: [],
  terms: [],
});

const spineWith = (ledger: SpineLedgerRow[], shapes: SpineV1["shapes"] = []): SpineV1 => ({
  schema: "spine/v1",
  id: "fixture",
  journey: [{ n: 1, step: "Choose", what: "a task is picked", why: "capacity is finite", invariant: null, breaksToday: null }],
  architecture: [{ part: "Broker", carries: ["1"], mechanism: null, constraint: null }],
  constraints: [],
  ledger,
  chapters: [],
  shapes,
});

const entry = (item: string, definedIn: string, kind: SpineLedgerRow["kind"] = "step"): SpineLedgerRow => ({ item, kind, definedIn, reusedIn: [] });

const rows = (beats: PaceSourceBeat[], spine?: SpineV1, required = false) =>
  new Map(ledgerRows(buildPaceBeats(beats), spine, required).map((r) => [r.check_id, r]));

const SEVEN_JOBS = ["choose", "make", "prove", "land", "keep going", "ask the owner", "be legible"];

describe("Q-E16 (M6) a list holds one declared kind", () => {
  // Mutation: reading kinds off the cue (every entry is a `job:`) instead of the ledger passes the mixed list.
  it("fails the seven jobs when the ledger declares 'be legible' a property among steps", () => {
    const ledger = SEVEN_JOBS.map((job) => entry(job, "r2-1-jobs", job === "be legible" ? "property" : "step"));

    const result = rows([source("r2-1-jobs", SEVEN_JOBS)], spineWith(ledger)).get("Q-E16");

    expect(result).toMatchObject({ severity: "error", pass: false, detail_beats: ["r2-1-jobs"] });
  });

  it("passes the same list when every job is declared a step", () => {
    const ledger = SEVEN_JOBS.map((job) => entry(job, "r2-1-jobs"));

    expect(rows([source("r2-1-jobs", SEVEN_JOBS)], spineWith(ledger)).get("Q-E16")?.pass).toBe(true);
  });

  it("checks a list's reused entries too, not only its new ones", () => {
    const ledger = [entry("choose", "r1"), entry("make", "r1"), entry("be legible", "r1", "property")];
    const beats = [source("r1", ["choose", "make"]), source("r1b", ["be legible"]), source("r2", ["choose", "make", "be legible"])];

    expect(rows(beats, spineWith(ledger)).get("Q-E16")?.detail_beats).toEqual(["r2"]);
  });

  // Mutation: a cut of 2 entries (the old `>= 2`) flags the pair.
  it("passes a two-entry pair whose kinds differ, since a stat and its target are not a list", () => {
    const ledger = [entry("20 patches", "r1", "number"), entry("aim: under five", "r1", "property")];

    expect(rows([source("r1", ["20 patches", "aim: under five"])], spineWith(ledger)).get("Q-E16")?.pass).toBe(true);
  });

  it("fails a three-entry parallel list whose kinds differ", () => {
    const ledger = [entry("choose", "r1"), entry("make", "r1"), entry("be legible", "r1", "property")];

    expect(rows([source("r1", ["choose", "make", "be legible"])], spineWith(ledger)).get("Q-E16")?.detail_beats).toEqual(["r1"]);
  });

  // Mutation: ignoring the declared shape flags the removal card.
  it("passes a removal card the spine declares a contrast, and still fails the same card declared parallel", () => {
    const ledger = [entry("weighted score · gone", "r1", "part"), entry("finish before start", "r1", "property"), entry("tier, then age", "r1", "property")];
    const card = [source("r1", ["weighted score · gone", "finish before start", "tier, then age"])];

    expect(rows(card, spineWith(ledger, [{ beat: "r1", shape: "contrast" }])).get("Q-E16")?.pass).toBe(true);
    expect(rows(card, spineWith(ledger, [{ beat: "r1", shape: "parallel" }])).get("Q-E16")?.detail_beats).toEqual(["r1"]);
  });
});

describe("Q-E17 every new item is ledgered and defined before its first use", () => {
  it("errors on a beat whose new item is missing from the ledger", () => {
    const result = rows([source("r1", ["choose", "make"])], spineWith([entry("choose", "r1")])).get("Q-E17");

    expect(result).toMatchObject({ severity: "error", pass: false, detail_beats: ["r1"] });
  });

  it("errors on an item whose defining beat comes after its first use, and passes one defined where first used", () => {
    const beats = [source("r1", ["choose"]), source("r2", ["make"]), source("r3", ["land"])];
    const ledger = [entry("choose", "r1"), entry("make", "r3"), entry("land", "r3")];

    expect(rows(beats, spineWith(ledger)).get("Q-E17")?.detail_beats).toEqual(["r2"]);
  });

  it("errors on a defining beat the script does not have", () => {
    expect(rows([source("r1", ["choose"])], spineWith([entry("choose", "r9")])).get("Q-E17")?.detail_beats).toEqual(["r1"]);
  });

  // Mutation: comparing beat ids as strings. "r10-1" sorts before "r2-1", so `make` would pass and `carry` would fail.
  it("compares defining beats by script order, not by id text", () => {
    const beats = [source("r2-1", ["make"]), source("r10-1", ["carry"])];
    const ledger = [entry("make", "r10-1"), entry("carry", "r2-1")];

    expect(rows(beats, spineWith(ledger)).get("Q-E17")?.detail_beats).toEqual(["r2-1"]);
  });

  it("matches ledger items case-folded and trimmed, as the item track does", () => {
    expect(rows([source("r1", ["Shepherd "])], spineWith([entry("shepherd", "r1", "part")])).get("Q-E17")?.pass).toBe(true);
  });
});

describe("a profile planned against a spine", () => {
  const script = (profile: string) => ScriptSchema.parse(scriptWith({ new_terms: ["desk server"] }, { profile }));

  // Mutation: passing Q-E17 whenever the spine is missing lets a design explainer ship without its ledger.
  it("fails Q-E17 without a spine, naming the beats that show new items", () => {
    const rowsFor = (profile: string) => new Map(runL0(script(profile), undefined, [ledgerCheck]).map((r) => [r.check_id, r]));

    expect(rowsFor("design-explainer").get("Q-E17")).toMatchObject({ pass: false, detail_beats: ["c2-1-stations"] });
    expect(rowsFor("repo-tour").get("Q-E17")?.pass).toBe(true);
  });

  it("reads the spine runL0 is given", () => {
    const spine = spineWith([entry("desk server", "c2-1-stations", "part")]);

    const result = runL0(script("design-explainer"), undefined, L0_CHECKS, undefined, spine).find((r) => r.check_id === "Q-E17");

    expect(result?.pass).toBe(true);
  });
});
