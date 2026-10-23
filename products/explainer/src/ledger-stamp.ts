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

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A handle such as "PR 2344" must not match inside "PR 23445" or "TP-4047-b".
const names = (spoken: string, handle: string): boolean => new RegExp(`(?<![\\w-])${escaped(handle)}(?![\\w-])`, "i").test(spoken);

const declares = (beat: ScriptBeat, handle: string): boolean => beat.new_terms.some((term) => term.trim().toLowerCase() === handle.toLowerCase());

const definesIn = (row: SpineLedgerRow, beat: ScriptBeat): boolean => row.definedIn === beat.chapter || row.definedIn === beat.id;

/**
 * Stamps `new_terms` on the first beat that speaks each ledger handle, when the ledger defines the item in that beat's
 * chapter and the model left it out. The model does not fill `new_terms` for ledger handles, and Q-E19 reads it. An
 * item first spoken before its defining chapter is left alone: that is a real Q-E17 failure, not a missing label.
 */
export function stampLedgerTerms(script: ScriptV1, spine: SpineV1): Stamped {
  const stamps: LedgerStamp[] = [];
  const added = new Map<string, string[]>();
  for (const row of spine.ledger) {
    const first = script.beats.find((beat) => names(beat.spoken, row.item));
    if (!first || !definesIn(row, first) || declares(first, row.item)) continue;
    added.set(first.id, [...(added.get(first.id) ?? []), row.item]);
    stamps.push({ beat: first.id, term: row.item });
  }
  if (stamps.length === 0) return { script, stamps };
  const beats = script.beats.map((beat) => (added.has(beat.id) ? { ...beat, new_terms: [...beat.new_terms, ...added.get(beat.id)!] } : beat));
  return { script: { ...script, beats }, stamps };
}
