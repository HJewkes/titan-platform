import assert from "node:assert/strict";
import { describe, test } from "vitest";
import fixture from "./fixtures/fixture.timeline.json" with { type: "json" };
import { resolveBeat } from "./registry.js";
import { parseTimeline, timelineUrl } from "./timeline.js";

describe("the composition page's beat registry", () => {
  test("an unknown kind throws and names the kinds it knows", () => {
    assert.throws(() => resolveBeat("hologram"), /^Error: unknown beat kind "hologram"; known kinds: title, catalogue$/);
  });

  test("an inherited property name is not a beat kind", () => {
    assert.throws(() => resolveBeat("toString"), /unknown beat kind "toString"/);
  });

  test("a catalogue beat missing a required slot is rejected", () => {
    const [, catalogue] = parseTimeline(fixture).beats;
    const slots = { ...(catalogue?.slots as Record<string, unknown>) };
    delete slots.schemaLabel;

    assert.throws(() => resolveBeat("catalogue").slots.parse(slots), /schemaLabel/);
  });
});

describe("timeline.json on the page", () => {
  test("a beat that runs past the timeline's duration is rejected", () => {
    const timeline = { durationS: 1, beats: [{ id: "a", kind: "title", startS: 0.5, durationS: 1, slots: {} }] };

    assert.throws(() => parseTimeline(timeline), /every beat must end within the timeline's durationS/);
  });

  test("?timeline= resolves against the page URL", () => {
    assert.equal(timelineUrl("http://127.0.0.1:9/index.html?timeline=/t/a.json"), "http://127.0.0.1:9/t/a.json");
  });

  test("a page URL with no ?timeline= throws", () => {
    assert.throws(() => timelineUrl("http://127.0.0.1:9/index.html"), /needs \?timeline=/);
  });
});
