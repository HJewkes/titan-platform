import type { L0Check, L0Result } from "./eval-l0.js";
import { ruleRow, wordsOf } from "./lint-text.js";
import { fromScriptV1, type PaceBeat } from "./pace-items.js";

/** M1: the most new items one beat may put on screen. */
export const MAX_NEW_ITEMS_PER_BEAT = 4;
/** M2 applies to beats with at least this many new items. */
export const DENSE_ITEM_COUNT = 4;
/** M2: heard seconds a new item, about a label plus one defining clause at 180 wpm. */
export const MIN_SECONDS_PER_ITEM = 2.0;
/** M2 before TTS: spoken words a new item stand in for heard seconds. */
export const MIN_WORDS_PER_ITEM = 4;
/** M4: seconds from the end of one dense beat to the start of the next. */
export const MIN_DIGEST_GAP_S = 15;
/** M7: new items a chapter minute. */
export const MAX_NEW_ITEMS_PER_MINUTE = 20;

const isCount = (label: string): boolean => /^\d/.test(label.trim());

// A PROMISE that lists at most three parts plus a count ("keeps, removes, adds, and eleven calls") previews the
// video's shape; the viewer is not asked to hold its items yet (SM:276).
function isPromiseExempt(beat: PaceBeat): boolean {
  const counts = beat.newItems.filter((i) => isCount(i.label)).length;
  return beat.fn === "PROMISE" && counts > 0 && beat.newItems.length - counts <= 3;
}

const overcrowded = (beat: PaceBeat): boolean => beat.newItems.length > MAX_NEW_ITEMS_PER_BEAT;

function rushed(beat: PaceBeat): boolean {
  const n = beat.newItems.length;
  if (n < DENSE_ITEM_COUNT || isPromiseExempt(beat)) return false;
  return beat.timed ? beat.durationS < MIN_SECONDS_PER_ITEM * n : wordsOf(beat.spoken).length < MIN_WORDS_PER_ITEM * n;
}

/** Dense beats (failing M1 or M2) that start within the digest gap of the previous dense beat's end, and that beat. */
function undigested(beats: readonly PaceBeat[]): string[] {
  const flagged: string[] = [];
  let startS = 0;
  let last: { id: string; endS: number } | undefined;
  for (const beat of beats) {
    if (overcrowded(beat) || rushed(beat)) {
      if (last && startS - last.endS < MIN_DIGEST_GAP_S) flagged.push(last.id, beat.id);
      last = { id: beat.id, endS: startS + beat.durationS };
    }
    startS += beat.durationS;
  }
  return [...new Set(flagged)];
}

/** One chapter's new items against its heard (or planned) length. */
export interface ChapterPace {
  chapter: string;
  newItems: number;
  seconds: number;
  perMinute: number;
}

/** New items a minute for each chapter, in script order. */
export function chapterPace(beats: readonly PaceBeat[]): ChapterPace[] {
  const byChapter = new Map<string, { newItems: number; seconds: number }>();
  for (const beat of beats) {
    const tally = byChapter.get(beat.chapter) ?? { newItems: 0, seconds: 0 };
    byChapter.set(beat.chapter, { newItems: tally.newItems + beat.newItems.length, seconds: tally.seconds + beat.durationS });
  }
  return [...byChapter].map(([chapter, { newItems, seconds }]) => ({ chapter, newItems, seconds, perMinute: (newItems * 60) / seconds }));
}

const beatRow = (check_id: string, severity: L0Result["severity"], beats: readonly string[]): L0Result =>
  ruleRow(check_id, { value: beats.length, threshold: 0, pass: beats.length === 0, beats, mode: "tagged", severity });

/**
 * The pace lints over an item track: Q-E7 (M1), Q-E8 (M2), Q-E9 (M4) and Q-E10 (M7). Q-E10's detail names
 * chapters, not beats, since its rate is a chapter's.
 */
export function paceRows(beats: readonly PaceBeat[]): L0Result[] {
  const fast = chapterPace(beats).filter((c) => c.newItems * 60 > MAX_NEW_ITEMS_PER_MINUTE * c.seconds);
  return [
    beatRow("Q-E7", "error", beats.filter(overcrowded).map((b) => b.id)),
    beatRow("Q-E8", "warning", beats.filter(rushed).map((b) => b.id)),
    beatRow("Q-E9", "warning", undigested(beats)),
    beatRow("Q-E10", "warning", fast.map((c) => c.chapter)),
  ];
}

const PACE_RULES: readonly [string, L0Result["severity"]][] = [["Q-E7", "error"], ["Q-E8", "warning"], ["Q-E9", "warning"], ["Q-E10", "warning"]];

const throws = (build: () => unknown): boolean => {
  try {
    build();
    return false;
  } catch {
    return true;
  }
};

// script/v1 admits inputs the item track refuses (a cue kind outside CUE_KIND_ROLES, a cue word the words.json
// never heard), and runL0 runs every check in one pass. Failing the pace rows on the beats that cannot be projected
// keeps one of them from taking every other L0 check's rows down with it.
function unprojectable({ script, timing }: Parameters<L0Check>[0]): L0Result[] {
  const bad = script.beats.filter((beat) => throws(() => fromScriptV1({ ...script, beats: [beat] }, timing))).map((b) => b.id);
  const named = bad.length > 0 ? bad : script.beats.map((b) => b.id);
  return PACE_RULES.map(([id, severity]) => beatRow(id, severity, named));
}

/** The pace lints on a script/v1, with heard durations when the run has a words.json. */
export const paceCheck: L0Check = (input) => {
  let beats: PaceBeat[];
  try {
    beats = fromScriptV1(input.script, input.timing);
  } catch {
    return unprojectable(input);
  }
  return paceRows(beats);
};
