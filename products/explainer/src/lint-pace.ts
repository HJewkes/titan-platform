import type { L0Check, L0Result } from "./eval-l0.js";
import { explainRoutes } from "./lint-gloss.js";
import { findingRoutes, unseated } from "./lint-seat.js";
import { ruleRow, wordsOf } from "./lint-text.js";
import { fromScriptV1, type PaceBeat } from "./pace-items.js";
import type { ScriptV1 } from "./script-schema.js";

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

/** M7: a chapter whose new items outrun the per-minute cap. */
export const tooFast = (c: ChapterPace): boolean => c.newItems * 60 > MAX_NEW_ITEMS_PER_MINUTE * c.seconds;

const beatRow = (check_id: string, severity: L0Result["severity"], beats: readonly string[], mode: L0Result["mode"] = "tagged"): L0Result =>
  ruleRow(check_id, { value: beats.length, threshold: 0, pass: beats.length === 0, beats, mode, severity });

/** One reused beat that fails a beat-level pace check, with the heard seconds it costs to re-voice. */
export interface ReuseFinding {
  beat: string;
  checks: string[];
  revoiceS: number;
}

// Q-E10 is left out: it names chapters, and a chapter's rate is not one beat's re-voice call.
const REUSE_CHECKS: readonly string[] = ["Q-E7", "Q-E8", "Q-E9", "Q-E11"];

/**
 * M9: each `origin: v2` beat that a beat-level row (Q-E7, Q-E8, Q-E9, Q-E11) names, with the heard seconds to
 * re-voice it. It only reads those rows; it never downgrades them.
 */
export function reuseFindings(beats: readonly PaceBeat[], rows: readonly L0Result[]): ReuseFinding[] {
  const named = rows.filter((r) => REUSE_CHECKS.includes(r.check_id));
  return beats
    .filter((beat) => beat.origin === "v2")
    .flatMap((beat) => {
      const checks = named.filter((r) => r.detail_beats.includes(beat.id)).map((r) => r.check_id);
      return checks.length > 0 ? [{ beat: beat.id, checks, revoiceS: beat.durationS }] : [];
    });
}

/**
 * The pace lints over an item track: Q-E7 (M1), Q-E8 (M2), Q-E9 (M4), Q-E10 (M7), Q-E11 (M5a), Q-E12 (M5b, routed),
 * Q-E13 (M9) and Q-E14 (M3-pre, routed); Q-E19 is added by `paceCheck`, since only a script/v1 declares `new_terms`. Q-E10's detail names chapters, not beats, since its rate is a chapter's.
 */
export function paceRows(beats: readonly PaceBeat[], invariants: readonly string[] = []): L0Result[] {
  const fast = chapterPace(beats).filter(tooFast);
  const rows = [
    beatRow("Q-E7", "error", beats.filter(overcrowded).map((b) => b.id)),
    beatRow("Q-E8", "warning", beats.filter(rushed).map((b) => b.id)),
    beatRow("Q-E9", "warning", undigested(beats)),
    beatRow("Q-E10", "warning", fast.map((c) => c.chapter)),
    beatRow("Q-E11", "error", unseated(beats, invariants)),
  ];
  return [
    ...rows,
    beatRow("Q-E12", "warning", findingRoutes(beats)),
    beatRow("Q-E13", "warning", reuseFindings(beats, rows).map((f) => f.beat)),
    beatRow("Q-E14", "warning", explainRoutes(beats).map((r) => r.beat), "heuristic"),
  ];
}

const PACE_RULES: readonly [string, L0Result["severity"]][] = [
  ["Q-E7", "error"], ["Q-E8", "warning"], ["Q-E9", "warning"], ["Q-E10", "warning"],
  ["Q-E11", "error"], ["Q-E12", "warning"], ["Q-E13", "warning"], ["Q-E14", "warning"],
  ["Q-E19", "warning"],
];

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

/**
 * Q-E19: beats that put a new item on screen without declaring it in `new_terms`. Q-F8, Q-E4 and Q-W2 read
 * `new_terms`, which defaults to `[]`, so a script that leaves it empty passes them vacuously.
 */
export function undeclaredTerms(script: ScriptV1, beats: readonly PaceBeat[]): string[] {
  const declared = new Map(script.beats.map((b) => [b.id, new Set(b.new_terms.map((t) => t.trim().toLowerCase()))]));
  return beats
    .filter((beat) => beat.newItems.some((i) => i.source !== "term" && !declared.get(beat.id)?.has(i.label.trim().toLowerCase())))
    .map((beat) => beat.id);
}

/** The pace lints on a script/v1, with heard durations when the run has a words.json. */
export const paceCheck: L0Check = (input) => {
  let beats: PaceBeat[];
  try {
    beats = fromScriptV1(input.script, input.timing);
  } catch {
    return unprojectable(input);
  }
  return [...paceRows(beats, input.script.video.invariants ?? []), beatRow("Q-E19", "warning", undeclaredTerms(input.script, beats))];
};
