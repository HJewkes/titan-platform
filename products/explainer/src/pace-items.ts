import { cueResolverFromWords } from "./cues.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";
import type { ScriptTiming } from "./timing.js";

export type PaceRole = "item" | "attribute" | "action";
export type PaceSource = "cue" | "reveal" | "pin" | "card" | "term" | "title";

/** One thing the viewer sees named on screen, and whether it adds to what they must hold. */
export interface PaceItem {
  label: string;
  kind: string;
  role: PaceRole;
  /** Seconds from the beat's start, or null when no word timings resolve its cue. */
  atS: number | null;
  source: PaceSource;
}

/** A beat as the pace layer reads it: its heard (or planned) length and the items it puts on screen. */
export interface PaceBeat {
  id: string;
  chapter: string;
  fn: string;
  spoken: string;
  durationS: number;
  /** False when `durationS` is the planned length, not a heard one. */
  timed: boolean;
  items: PaceItem[];
  /** Items of role `item` whose label no earlier beat showed. */
  newItems: PaceItem[];
  origin?: string;
  mapBeside: boolean;
  render?: string;
}

// note, title and chip are items: each is a line of on-screen text that names something new for the viewer to
// read and hold (a recipe caption, an outro title card, a target chip), not a qualifier of an item already shown
// (an attribute) nor an animation of one (an action). stamp and line are attributes: a stamp marks the state of
// a row already on screen, and a line highlights a line of code the CodeWalk already shows.
// edge is an item: a build/buy table row names a new thing (a part and its verdict) for the viewer to read.
// orphan is an attribute: it marks nodes already on screen as unreached, naming nothing new.
// wait is an action: it animates elapsed time in a recipe (a CI pause), like run and replay.
// edit is an action: it rewrites a line of code already shown, as insert adds one, naming no new item.
export const CUE_KIND_ROLES: Readonly<Record<string, PaceRole>> = {
  job: "item",
  inv: "item",
  measure: "item",
  row: "item",
  open: "item",
  risk: "item",
  card: "item",
  stat: "item",
  rung: "item",
  rail: "item",
  note: "item",
  title: "item",
  chip: "item",
  fan: "item",
  legend: "item",
  rule: "item",
  rows: "item",
  col: "item",
  check: "item",
  gate: "item",
  bar: "item",
  gauge: "item",
  edge: "item",
  detail: "attribute",
  left: "attribute",
  right: "attribute",
  stamp: "attribute",
  line: "attribute",
  orphan: "attribute",
  run: "action",
  crash: "action",
  bump: "action",
  stale: "action",
  replay: "action",
  insert: "action",
  release: "action",
  wait: "action",
  edit: "action",
};

/** The role of a cue kind; an unknown kind throws, so a new renderer cannot go silently uncounted. */
export function cueKindRole(kind: string): PaceRole {
  const role = Object.hasOwn(CUE_KIND_ROLES, kind) ? CUE_KIND_ROLES[kind] : undefined;
  if (!role) throw new Error(`unknown cue kind "${kind}": add it to CUE_KIND_ROLES`);
  return role;
}

interface Cued {
  label: string;
  atCue?: string;
}

/** The adapter-neutral fields one beat contributes to the item track. */
export interface PaceSourceBeat {
  id: string;
  chapter: string;
  fn: string;
  spoken: string;
  plannedS: number;
  origin?: string;
  render?: string;
  mapBeside: boolean;
  cues: { target: string; atCue?: string }[];
  titles: string[];
  reveals: (Cued & { id: string })[];
  pins: (Cued & { anchor: string })[];
  cards: Cued[];
  terms: string[];
}

type AtS = (cue: string | undefined) => number | null;

const COUNT_KINDS = new Set(["card", "fan"]);

const isCountCard = (beat: PaceSourceBeat, kind: string, label: string): boolean =>
  beat.render === "HookBeat" && COUNT_KINDS.has(kind) && /^\d/.test(label);

function cueItems(beat: PaceSourceBeat, atS: AtS): PaceItem[] {
  return beat.cues.flatMap(({ target, atCue }) => {
    const colon = target.indexOf(":");
    const kind = colon < 0 ? target : target.slice(0, colon);
    const label = colon < 0 ? target : target.slice(colon + 1);
    const role = cueKindRole(kind);
    return isCountCard(beat, kind, label) ? [] : [{ label, kind, role, atS: atS(atCue), source: "cue" as const }];
  });
}

function beatItems(beat: PaceSourceBeat, atS: AtS): PaceItem[] {
  const revealed = new Set(beat.reveals.map((r) => r.id));
  const item = (source: PaceSource, kind: string, { label, atCue }: Cued, role: PaceRole = "item"): PaceItem => ({
    label,
    kind,
    role,
    atS: atS(atCue),
    source,
  });
  return [
    ...cueItems(beat, atS),
    ...beat.titles.map((label) => item("title", "side-title", { label })),
    ...beat.reveals.map((r) => item("reveal", "reveal", r)),
    ...beat.pins.map((p) => item("pin", "pin", p, revealed.has(p.anchor) ? "attribute" : "item")),
    ...beat.cards.map((c) => item("card", "card", c)),
    ...beat.terms.map((label) => item("term", "term", { label })),
  ];
}

/** How the item track compares labels: case-folded and trimmed, so "Shepherd" and " shepherd" are one item. */
export const labelKey = (label: string): string => label.trim().toLowerCase();

function cueSeconds(beatId: string, timing: ScriptTiming | undefined): AtS {
  const words = timing?.get(beatId)?.words;
  if (!words) return () => null;
  const resolve = cueResolverFromWords({ [beatId]: words });
  return (cue) => (cue === undefined ? null : resolve(beatId, cue));
}

/** Projects source beats, in script order, to the item track; `timing` supplies heard durations and cue times. */
export function buildPaceBeats(beats: readonly PaceSourceBeat[], timing?: ScriptTiming): PaceBeat[] {
  const seen = new Set<string>();
  return beats.map((beat) => {
    const items = beatItems(beat, cueSeconds(beat.id, timing));
    const newItems = items.filter((i) => {
      const key = labelKey(i.label);
      if (i.role !== "item" || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const heard = timing?.get(beat.id);
    const { id, chapter, fn, spoken, origin, render, mapBeside } = beat;
    return {
      id,
      chapter,
      fn,
      spoken,
      durationS: heard?.durationS ?? beat.plannedS,
      timed: heard !== undefined,
      items,
      newItems,
      mapBeside,
      ...(origin === undefined ? {} : { origin }),
      ...(render === undefined ? {} : { render }),
    };
  });
}

function v1SourceBeat(beat: ScriptBeat): PaceSourceBeat {
  const state = beat.visual.map_state;
  return {
    id: beat.id,
    chapter: beat.chapter,
    fn: beat.function,
    spoken: beat.spoken,
    plannedS: beat.plannedS,
    ...(beat.kind === undefined ? {} : { render: beat.kind }),
    mapBeside: state !== undefined,
    cues: beat.visual.cues,
    titles: [],
    reveals: (state?.reveal ?? []).map((r) => ({ id: r.id, label: r.id, atCue: r.atCue })),
    pins: (state?.pins ?? []).map((p) => ({ anchor: p.anchor, label: p.text, atCue: p.atCue })),
    cards: (state?.cards ?? []).map((c) => ({ label: c.ref, atCue: c.atCue })),
    terms: beat.new_terms,
  };
}

/** The item track of a parsed `script/v1`. Its beats carry `kind` as the render hint; map reveals are labelled by node id. */
export function fromScriptV1(script: ScriptV1, timing?: ScriptTiming): PaceBeat[] {
  return buildPaceBeats(script.beats.map(v1SourceBeat), timing);
}
