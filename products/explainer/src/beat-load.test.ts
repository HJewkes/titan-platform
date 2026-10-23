import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { beatSpec, BEATS, codeWalkSlots } from "./beat-fixtures.test-helpers.js";
import { BeatSlotError, beatSpecFor, emphasisTargets, loadBeatSpecs, parseBeatSlots, UnknownBeatError } from "./beat-load.js";
import { BeatSpecSchema } from "./beat-schema.js";

const PROFILE_PLAN_BEATS = [
  "verdict-card",
  "change-group",
  "diff-map",
  "finding-card",
  "proof",
  "frame-flow",
  "replot",
  "sim",
  "rule-diff",
  "kanban-flow",
  "gantt",
  "forecast",
  "history-why",
  "attempt",
  "companion-link",
];

function writeBeats(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "beats-"));
  mkdirSync(join(dir, "beats"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "beats", name), stringify(body));
  return dir;
}

describe("loadBeatSpecs", () => {
  it("loads the shipped registry, the profiles plan's beats among it", () => {
    const types = [...loadBeatSpecs().keys()];

    expect(types).toEqual(expect.arrayContaining([...PROFILE_PLAN_BEATS, "code-walk", "hook"]));
  });

  it("rejects an unknown beat, naming the known ones", () => {
    expect(() => beatSpecFor(loadBeatSpecs(), "timeline-strip")).toThrow(UnknownBeatError);
    expect(() => beatSpecFor(loadBeatSpecs(), "timeline-strip")).toThrow(/known: .*verdict-card/);
  });

  it("rejects a file whose name differs from its type", () => {
    const dir = writeBeats({ "code-tour.yaml": beatSpec("code-walk") });

    expect(() => loadBeatSpecs(dir)).toThrow("beats/code-tour.yaml: names code-walk, so the file is code-walk.yaml");
  });

  it("rejects a shape error, naming the file", () => {
    const dir = writeBeats({ "code-walk.yaml": { ...beatSpec("code-walk"), speech: { band: "lecture" } } });

    expect(() => loadBeatSpecs(dir)).toThrow(/beats\/code-walk\.yaml: .*band/s);
  });
});

describe("BeatSpecSchema", () => {
  it("rejects a default emphasis treatment: the template picks per cue", () => {
    const spec = { ...beatSpec("code-walk"), emphasis: { targets: ["lines"], treatments: ["pointer"], default: "pointer" } };

    expect(BeatSpecSchema.safeParse(spec).success).toBe(false);
  });

  it.each([
    ["a gap that names a component", { name: "AttemptCard", maturity: "gap" }],
    ["a built component with no name", { maturity: "spike" }],
  ])("rejects %s", (_name, component) => {
    expect(BeatSpecSchema.safeParse({ ...beatSpec("code-walk"), component }).success).toBe(false);
  });
});

describe("parseBeatSlots", () => {
  it("returns the slots a sound beat fills", () => {
    expect(parseBeatSlots(BEATS, "code-walk", codeWalkSlots())).toEqual(codeWalkSlots());
  });

  it("rejects an unknown beat", () => {
    expect(() => parseBeatSlots(BEATS, "timeline-strip", codeWalkSlots())).toThrow(UnknownBeatError);
  });

  it.each([
    ["a missing slot", codeWalkSlots({ path: undefined }), /path/],
    ["a slot it does not know", codeWalkSlots({ theme: "dark" }), /theme/],
    ["too many lines", codeWalkSlots({ lines: Array.from({ length: 11 }, (_, i) => ({ id: `l${i}`, text: "x" })) }), /lines/],
    ["an element id that is not kebab-case", codeWalkSlots({ lines: [{ id: "Line 1", text: "x" }] }), /lines\.0\.id/],
    ["an element id used twice, so a cue would not resolve to one element", codeWalkSlots({ lines: [{ id: "a", text: "x" }, { id: "a", text: "y" }] }), /lines repeats element id a/],
  ])("rejects %s", (_name, slots, message) => {
    expect(() => parseBeatSlots(BEATS, "code-walk", slots)).toThrow(BeatSlotError);
    expect(() => parseBeatSlots(BEATS, "code-walk", slots)).toThrow(message);
  });

  it("rejects bad slots for a shipped beat", () => {
    expect(() => parseBeatSlots(loadBeatSpecs(), "proof", { checks: [{ id: "unit", name: "unit", base: "pass", head: "skipped" }] })).toThrow(/checks\.0\.head/);
  });
});

describe("emphasisTargets", () => {
  it("lists the element ids a cue may name", () => {
    const slots = parseBeatSlots(BEATS, "code-walk", codeWalkSlots());

    expect(emphasisTargets(beatSpecFor(BEATS, "code-walk"), slots)).toEqual(["open", "close"]);
  });
});
