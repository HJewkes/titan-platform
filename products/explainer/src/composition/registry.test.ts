import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { BEAT_SLOTS, isSlotRef } from "../beat-slots.js";
import { loadBeatSpecs } from "../beat-load.js";
import fixture from "./fixtures/fixture.timeline.json" with { type: "json" };
import { CatalogueSlots } from "./beats/catalogue.js";
import { registeredKinds, resolveBeat } from "./registry.js";
import { parseTimeline, timelineUrl } from "./timeline.js";

/** Registry keys that are no doctrine spec type: the react-ui showcase the page has drawn since TP-2991. */
const SHOWCASE_KINDS = new Set(["catalogue"]);

describe("the composition page's beat registry", () => {
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
