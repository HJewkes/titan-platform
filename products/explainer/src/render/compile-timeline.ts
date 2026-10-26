import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBeatSpecs, parseBeatSlots } from "../beat-load.js";
import { parseTimeline, type Timeline, type TimelineBeat } from "../composition/timeline.js";
import { cueResolverFromWords, type CueResolver } from "../cues.js";
import { canonicalJson } from "../eval-store.js";
import type { Beat, Storyboard } from "../storyboard.js";
import { readTiming, type ScriptTiming } from "../timing.js";

/** Parses one beat's raw slots for its spec type into the props the page reads. */
export type SlotsFor = (type: string, raw: unknown) => Record<string, unknown>;

export interface CompileDeps {
  slotsFor?: SlotsFor;
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

/** Beat-local cue seconds keyed by the cue as written, ordered by time then name; none without spoken words. */
function beatCues(beat: Beat, resolve: CueResolver | undefined): Record<string, number> | undefined {
  if (!resolve || !beat.cues || beat.cues.length === 0) return undefined;
  const resolved = beat.cues.map((cue) => [cue, resolve(beat.id, cue)] as const);
  resolved.sort(([a, atA], [b, atB]) => atA - atB || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(resolved);
}

/**
 * The page's `timeline.json` from a parsed storyboard and an optional raw words.json (the only reader of it).
 * Without words every duration is planned, cues are omitted and the timeline is provisional.
 */
export function compileTimeline(board: Storyboard, words?: unknown, deps: CompileDeps = {}): Timeline {
  const timing = words === undefined ? undefined : readTiming(words);
  if (timing) assertSameBeats(board, timing);
  const slotsFor = deps.slotsFor ?? registrySlots();
  const resolve = timing && resolverFor(timing);
  const durations = beatDurations(board, timing);
  let startS = 0;
  const beats = board.beats.map((beat, i): TimelineBeat => {
    const durationS = durations[i] ?? beat.duration_s;
    const cues = beatCues(beat, resolve);
    const compiled = { id: beat.id, kind: beat.type, startS, durationS, ...(cues ? { cues } : {}), slots: slotsFor(beat.type, beat.slots) };
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
