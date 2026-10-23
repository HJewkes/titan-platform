import type { L0Result } from "./eval-l0.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";
import type { SpineLedgerRow, SpineV1 } from "./spine-schema.js";

export interface LedgerStamp {
  beat: string;
  term: string;
}

export interface Stamped {
  script: ScriptV1;
  stamps: LedgerStamp[];
}

/** The L0 rows a stamp is measured against: the same lint the stage gates and repairs on. */
export type StampLint = (script: ScriptV1) => readonly L0Result[];

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A handle such as "PR 2344" must not match inside "PR 23445" or "TP-4047-b".
const names = (spoken: string, handle: string): boolean => new RegExp(`(?<![\\w-])${escaped(handle)}(?![\\w-])`, "i").test(spoken);

const declares = (beat: ScriptBeat, handle: string): boolean => beat.new_terms.some((term) => term.trim().toLowerCase() === handle.toLowerCase());

const definesIn = (row: SpineLedgerRow, beat: ScriptBeat): boolean => row.definedIn === beat.chapter || row.definedIn === beat.id;

// Keyed per beat, so a stamp that fails an already-failing rule on one more beat still counts as a new error.
const errorKeys = (rows: readonly L0Result[]): Set<string> =>
  new Set(rows.filter((r) => r.severity === "error" && !r.pass).flatMap((r) => (r.detail_beats.length ? r.detail_beats.map((b) => `${r.check_id}@${b}`) : [r.check_id])));

const withTerm = (script: ScriptV1, beatId: string, term: string): ScriptV1 => ({
  ...script,
  beats: script.beats.map((beat) => (beat.id === beatId ? { ...beat, new_terms: [...beat.new_terms, term] } : beat)),
});

const candidates = (script: ScriptV1, spine: SpineV1): LedgerStamp[] =>
  spine.ledger.flatMap((row) => {
    const first = script.beats.find((beat) => names(beat.spoken, row.item));
    if (!first || !definesIn(row, first)) return [];
    const declared = script.beats.some((beat) => beat.chapter === first.chapter && declares(beat, row.item));
    return declared ? [] : [{ beat: first.id, term: row.item }];
  });

/**
 * Stamps `new_terms` on the first beat that speaks each ledger handle, when the ledger defines the item in that beat's
 * chapter and the model declared it nowhere in that chapter. The model does not fill `new_terms` for ledger handles,
 * and Q-E19 reads it. An item first spoken before its defining chapter is left alone: that is a real Q-E17 failure,
 * not a missing label. Many error rules read `new_terms` (Q-E4, Q-F8, Q-W2, the pace counts), so rather than mirror
 * each, a stamp is kept only when `lint` fails no error row, on any beat, that the script did not already fail.
 */
export function stampLedgerTerms(script: ScriptV1, spine: SpineV1, lint: StampLint): Stamped {
  const stamps: LedgerStamp[] = [];
  let current = script;
  let failing = errorKeys(lint(script));
  for (const stamp of candidates(script, spine)) {
    const trial = withTerm(current, stamp.beat, stamp.term);
    const after = errorKeys(lint(trial));
    if ([...after].some((key) => !failing.has(key))) continue;
    [current, failing] = [trial, after];
    stamps.push(stamp);
  }
  return { script: current, stamps };
}
