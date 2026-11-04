import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { BEAT_SLOTS, isSlotRef } from "../beat-slots.js";
import { loadBeatSpecs } from "../beat-load.js";
import { loadTypeProfiles } from "../profile-load.js";
import type { TypeProfile } from "../profile-schema.js";
import fixture from "./fixtures/fixture.timeline.json" with { type: "json" };
import { CatalogueSlots } from "./beats/catalogue.js";
import { registeredKinds, resolveBeat } from "./registry.js";
import { parseTimeline, timelineUrl } from "./timeline.js";

/** Registry keys that are no doctrine spec type: the react-ui showcase the page has drawn since TP-2991. */
const SHOWCASE_KINDS = new Set(["catalogue"]);

/**
 * Spec types a shipped profile can put on the page that the registry does not draw yet, each with why. Every
 * TP-4276 slice removes the kinds it ports; an entry the registry now draws fails the fence, so the list only shrinks.
 */
const NOT_DRAWN: Readonly<Record<string, string>> = {
  "metrics-panel": "pin-only, falls back to list; ScorecardTable port is TP-4277",
  "kanban-flow": "pin-only, falls back to list; no component anywhere yet (design first, TP-4277)",
  stakes: "TP-4277 (P4a) ports StatBeat for it",
  "issue-pin": "TP-4277 (P4a) draws the list form; falls back to list without pins",
  "code-walk": "TP-4277 (P4a) ports CodeWalkBeat",
  fix: "TP-4277 (P4a) ports CodeWalkBeat",
  "docs-vs-code": "TP-4277 (P4a) ports CompareBeat with code lines",
  misconception: "TP-4277 (P4a) ports CompareBeat",
  promise: "TP-4277 (P4a) ports StepRailBeat",
  "user-flow": "TP-4277 (P4a) ports StepRailBeat",
  chapter: "TP-4277 (P4a) ports TitleBeat",
  "chapter-open": "TP-4277 (P4a) ports ChapterOpen",
  takeaways: "TP-4277 (P4a) ports ListBeat",
  zoom: "TP-4277 (P4a) ports ArchMapBeat",
  "companion-link": "TP-4277 (P4a) uses react-ui ChapterCard",
  schema: "TP-4277 (P4b) uses react-ui SchemaCard",
  history: "TP-4277 (P4b) uses react-ui Timeline",
  "history-why": "TP-4277 (P4b) uses react-ui Timeline",
  scorecard: "TP-4277 (P4b) ports ScorecardTable",
  "change-group": "TP-4277 (P4b) ports ListBeat",
  "finding-card": "TP-4277 (P4b) ports ListBeat",
  "reading-list": "TP-4277 (P4b) ports ListBeat",
  proof: "TP-4277 (P4b) ports ChecklistBeat",
  "context-map": "TP-4277 (P4c) ports MapBeat",
  "info-flow": "TP-4277 (P4c) ports MapBeat",
  "request-walk": "TP-4277 (P4c) ports MapBeat",
  "diff-map": "TP-4277 (P4c) ports SplitMapBeat",
  "entry-points": "TP-4277 (P4c) ports StationMap",
  "algo-trace": "TP-4277 (P4c) ports RecipeRunBeat",
  sequence: "no component anywhere: design first in titan-design",
  gantt: "no component anywhere: design first in titan-design",
  forecast: "no component anywhere: design first in titan-design",
  replot: "no component anywhere: design first in titan-design",
  "rule-diff": "no component anywhere: design first in titan-design",
  "verdict-chip": "no component anywhere: design first in titan-design",
  "frame-flow": "no component anywhere: design first in titan-design",
  attempt: "no component anywhere: design first in titan-design",
  dsm: "no component anywhere: design first in titan-design",
  sim: "no component anywhere: design first in titan-design",
};

/** A spec the fill cannot derive falls back (template-fill fill.ts): list from anything, outro from a button. */
const fallbacksOf = (beats: ReadonlySet<string>): string[] => ["list", ...(beats.has("button") ? ["outro"] : [])];

function pageKinds(profile: TypeProfile): Set<string> {
  const beats = new Set(profile.structure.blocks.flatMap((block) => [...block.beats, ...(block.require ?? [])]));
  return new Set([...beats, ...fallbacksOf(beats)]);
}

const shippedPageKinds = (): Map<string, Set<string>> =>
  new Map([...loadTypeProfiles()].map(([type, profile]) => [type, pageKinds(profile)]));

describe("the composition page's beat registry", () => {
  test("an unknown kind throws and names the kinds it knows", () => {
    assert.throws(() => resolveBeat("hologram"), /^Error: unknown beat kind "hologram"; known kinds: hook, held, list, verdict-card, fact-flash, claim-card, button, outro, stat, chart, compare, arch-map, catalogue$/);
  });

  test("an inherited property name is not a beat kind", () => {
    assert.throws(() => resolveBeat("toString"), /unknown beat kind "toString"/);
  });

  test("a hook beat's slots are BEAT_SLOTS.hook's, defaults included", () => {
    assert.deepEqual(resolveBeat("hook").slots.parse({ line: "A line" }), { line: "A line", cards: [] });
  });

  test("a catalogue beat missing a required slot is rejected", () => {
    const [, catalogue] = parseTimeline(fixture).beats;
    const slots = { ...CatalogueSlots.parse(catalogue?.slots), schemaLabel: undefined };

    assert.throws(() => resolveBeat("catalogue").slots.parse(slots), /schemaLabel/);
  });

  test("hook and catalogue draw on the whole page and every spec kind past them in the stage box", () => {
    const page = registeredKinds().filter((kind) => !resolveBeat(kind).stage);

    assert.deepEqual(page, ["hook", "catalogue"]);
  });

  // Mutation: let claim-card keep the chrome headline; the title and the headline say the claim twice.
  test("a title or outro kind is its own headline, so the chrome shows none over it", () => {
    const bare = registeredKinds().filter((kind) => resolveBeat(kind).stage && !resolveBeat(kind).headline);

    assert.deepEqual(bare, ["claim-card", "button", "outro"]);
  });
});

describe("registry keys against the doctrine beat specs", () => {
  // Mutation: wire a kind to another ref's schema (held: BEAT_SLOTS.outro); its spec names ref held, so the pair differs.
  test("each registered spec type parses with the slots schema its spec's ref names", () => {
    const specs = loadBeatSpecs();
    const kinds = registeredKinds().filter((kind) => !SHOWCASE_KINDS.has(kind));

    const wrong = kinds.filter((kind) => {
      const ref = specs.get(kind)?.slots;
      return ref === undefined || !isSlotRef(ref) || resolveBeat(kind).slots !== BEAT_SLOTS[ref];
    });

    assert.deepEqual(wrong, []);
  });

  test("a showcase kind is no spec type, so it cannot shadow one", () => {
    const specs = loadBeatSpecs();

    const shadowing = [...SHOWCASE_KINDS].filter((kind) => specs.has(kind));

    assert.deepEqual(shadowing, []);
  });
});

describe("profile coverage fence", () => {
  // Mutation: delete an entry (stakes) from NOT_DRAWN; pr can emit stakes and nothing draws it.
  test("every spec type a shipped profile can put on the page is registered or on NOT_DRAWN", () => {
    const uncovered = [...shippedPageKinds()].flatMap(([type, kinds]) =>
      [...kinds].filter((kind) => !Object.hasOwn(NOT_DRAWN, kind) && !registeredKinds().includes(kind)).map((kind) => `${type}: ${kind}`),
    );

    assert.deepEqual(uncovered, []);
  });

  test("NOT_DRAWN names no kind the registry draws, and each entry is a spec type with a reason", () => {
    const specs = loadBeatSpecs();

    const stale = Object.entries(NOT_DRAWN).filter(([kind, reason]) => registeredKinds().includes(kind) || !specs.has(kind) || reason.trim() === "");

    assert.deepEqual(stale, []);
  });

  test("daily-overview's undrawn kinds are only the pin-only ones", () => {
    const daily = shippedPageKinds().get("daily-overview") ?? new Set<string>();

    const undrawn = [...daily].filter((kind) => !registeredKinds().includes(kind)).sort();

    assert.deepEqual(undrawn, ["kanban-flow"]);
  });
});

describe("timeline.json on the page", () => {
  test("a beat that runs past the timeline's duration is rejected", () => {
    const timeline = { durationS: 1, beats: [{ id: "a", kind: "hook", startS: 0.5, durationS: 1, slots: {} }] };

    assert.throws(() => parseTimeline(timeline), /every beat must end within the timeline's durationS/);
  });

  test("a reveal past its beat's end is rejected", () => {
    const beat = { id: "a", kind: "held", startS: 0, durationS: 1, slots: {}, reveals: [{ target: "row-1", atS: 1.5 }] };

    assert.throws(() => parseTimeline({ durationS: 1, beats: [beat] }), /every reveal must land within its beat's durationS/);
  });

  test("a chapter numbered past its count is rejected", () => {
    const beat = { id: "a", kind: "held", startS: 0, durationS: 1, slots: {}, chapter: { n: 5, of: 4, label: "Lanes" } };

    assert.throws(() => parseTimeline({ durationS: 1, beats: [beat] }), /a chapter's n must not pass its of/);
  });

  test("?timeline= resolves against the page URL", () => {
    assert.equal(timelineUrl("http://127.0.0.1:9/index.html?timeline=/t/a.json"), "http://127.0.0.1:9/t/a.json");
  });

  test("a page URL with no ?timeline= throws", () => {
    assert.throws(() => timelineUrl("http://127.0.0.1:9/index.html"), /needs \?timeline=/);
  });
});
