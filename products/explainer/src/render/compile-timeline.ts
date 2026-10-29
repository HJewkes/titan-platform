import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBeatSpecs, parseBeatSlots } from "../beat-load.js";
import { parseTimeline, type Timeline, type TimelineBeat } from "../composition/timeline.js";
import { cueResolverFromWords, type CueResolver } from "../cues.js";
import { canonicalJson } from "../eval-store.js";
import { plainWords, spokenWordIndex } from "../script-schema.js";
import type { Beat, Storyboard } from "../storyboard.js";
import { readTiming, type ScriptTiming } from "../timing.js";
import type { PageExtras } from "./board-from-fill.js";

/** Parses one beat's raw slots for its spec type into the props the page reads. */
type SlotsFor = (type: string, raw: unknown) => Record<string, unknown>;

interface CompileDeps {
  slotsFor?: SlotsFor;
  /** What the page draws beside each beat's slots, by storyboard id (boardFromFill); a beat without any carries none. */
  extras?: ReadonlyMap<string, PageExtras>;
  /** Storyboard ids of custom-layer beats: they hold no slots, since their built layer draws them. */
  custom?: ReadonlySet<string>;
}

// BEAT_SLOTS stands in for the @titan-design/beats registry until it publishes (TD-907); the page parses the same schemas.
function registrySlots(): SlotsFor {
  const specs = loadBeatSpecs();
  return (type, raw) => parseBeatSlots(specs, type, raw);
}

/** Board and words.json must name the same beats, so a stale words file fails before any render. */
function assertSameBeats(board: Storyboard, timing: ScriptTiming): void {
  const ids = new Set(board.beats.map((beat) => beat.id));
  for (const beat of board.beats) {
    if (!timing.has(beat.id)) throw new Error(`${beat.id} was never voiced`);
  }
  for (const id of timing.keys()) {
    if (!ids.has(id)) throw new Error(`words.json names ${id}, which the board lacks`);
  }
}

/** Heard durations when the board was voiced, planned ones otherwise. */
function beatDurations(board: Storyboard, words: ScriptTiming | undefined): number[] {
  return board.beats.map((beat) => {
    const timing = words?.get(beat.id);
    return timing ? timing.durationS : beat.duration_s;
  });
}

function resolverFor(timing: ScriptTiming): CueResolver {
  return cueResolverFromWords(Object.fromEntries([...timing].map(([id, beat]) => [id, beat.words ?? []])));
}

/** Planned-word times for a provisional timeline: the cue word's place in the spoken line, scaled to the planned seconds. */
function plannedResolver(board: Storyboard): CueResolver {
  const beats = new Map(board.beats.map((beat) => [beat.id, beat]));
  return (beatId, cue) => {
    const beat = beats.get(beatId)!;
    return (spokenWordIndex(beat)(cue) / plainWords(beat.spoken).length) * beat.duration_s;
  };
}

/** A beat's page extras with each reveal's cue resolved to beat-local seconds; nothing when the beat carries none. */
function pageFields(beatId: string, extras: PageExtras | undefined, resolve: CueResolver): Partial<TimelineBeat> {
  if (!extras) return {};
  const reveals = extras.reveals.map(({ target, part, atCue }) => ({ target, ...(part ? { part } : {}), atS: resolve(beatId, atCue) }));
  const { chips, hints, headline, chapter } = extras;
  return { reveals, chips, hints, headline, chapter };
}

/** Beat-local cue seconds keyed by the cue as written, ordered by time then name; none without spoken words. */
function beatCues(beat: Beat, resolve: CueResolver | undefined): Record<string, number> | undefined {
  if (!resolve || !beat.cues || beat.cues.length === 0) return undefined;
  const resolved = beat.cues.map((cue) => [cue, resolve(beat.id, cue)] as const);
  resolved.sort(([a, atA], [b, atB]) => atA - atB || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(resolved);
}

/**
 * The page's `timeline.json` from a parsed storyboard and an optional raw words.json (the only reader of it).
 * Without words every duration is planned, cues are omitted, reveals land at planned-word times and the timeline is
 * provisional.
 */
export function compileTimeline(board: Storyboard, words?: unknown, deps: CompileDeps = {}): Timeline {
  const timing = words === undefined ? undefined : readTiming(words);
  if (timing) assertSameBeats(board, timing);
  const slotsFor = deps.slotsFor ?? registrySlots();
  const resolve = timing && resolverFor(timing);
  const revealAt = resolve ?? plannedResolver(board);
  const durations = beatDurations(board, timing);
  let startS = 0;
  const beats = board.beats.map((beat, i): TimelineBeat => {
    const durationS = durations[i] ?? beat.duration_s;
    const cues = beatCues(beat, resolve);
    const page = pageFields(beat.id, deps.extras?.get(beat.id), revealAt);
    const compiled = { id: beat.id, kind: beat.type, startS, durationS, ...(cues ? { cues } : {}), slots: deps.custom?.has(beat.id) ? {} : slotsFor(beat.type, beat.slots), ...page };
    startS += durationS;
    return compiled;
  });
  return parseTimeline({ durationS: startS, provisional: !timing, beats });
}

/** Writes `<dir>/timeline.json` as canonical JSON, so the same timeline always gives the same bytes. */
export function writeTimeline(dir: string, timeline: Timeline): string {
  const path = join(dir, "timeline.json");
  writeFileSync(path, `${canonicalJson(timeline)}\n`);
  return path;
}
