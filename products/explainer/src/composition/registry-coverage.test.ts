import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadBeatSpecs } from "../beat-load.js";
import { loadTypeProfiles } from "../profile-load.js";
import type { TypeProfile } from "../profile-schema.js";
import { registeredKinds } from "./registry.js";

/**
 * Spec types a shipped profile can put on the page that the registry does not draw yet, each with why. Every
 * TP-4276 slice removes the kinds it ports; an entry the registry now draws fails the fence, so the list only shrinks.
 */
const NOT_DRAWN: Readonly<Record<string, string>> = {
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
  "change-group": "TP-4277 (P4b) ports ListBeat",
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
