import assert from "node:assert/strict";
import { describe, test } from "vitest";
import fixture from "./fixtures/fixture.timeline.json" with { type: "json" };
import { CatalogueSlots } from "./beats/catalogue.js";
import { resolveBeat } from "./registry.js";
import { parseTimeline, timelineUrl } from "./timeline.js";

describe("the composition page's beat registry", () => {
  test("an unknown kind throws and names the kinds it knows", () => {
    assert.throws(() => resolveBeat("hologram"), /^Error: unknown beat kind "hologram"; known kinds: hook, catalogue$/);
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
});

describe("timeline.json on the page", () => {
  test("a beat that runs past the timeline's duration is rejected", () => {
    const timeline = { durationS: 1, beats: [{ id: "a", kind: "hook", startS: 0.5, durationS: 1, slots: {} }] };

    assert.throws(() => parseTimeline(timeline), /every beat must end within the timeline's durationS/);
  });

  test("?timeline= resolves against the page URL", () => {
    assert.equal(timelineUrl("http://127.0.0.1:9/index.html?timeline=/t/a.json"), "http://127.0.0.1:9/t/a.json");
  });

  test("a page URL with no ?timeline= throws", () => {
    assert.throws(() => timelineUrl("http://127.0.0.1:9/index.html"), /needs \?timeline=/);
  });
});
