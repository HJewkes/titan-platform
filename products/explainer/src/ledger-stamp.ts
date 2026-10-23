import { MAX_NEW_NAMES_PER_CHAPTER } from "./lint-evidence.js";
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

/** Q-F8's per-beat limit on `new_terms`; the rule keeps it inline, so the stamp mirrors it rather than read it. */
const MAX_TERMS_PER_BEAT = 2;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A handle such as "PR 2344" must not match inside "PR 23445" or "TP-4047-b".
const names = (spoken: string, handle: string): boolean => new RegExp(`(?<![\\w-])${escaped(handle)}(?![\\w-])`, "i").test(spoken);

const declares = (beat: ScriptBeat, handle: string): boolean => beat.new_terms.some((term) => term.trim().toLowerCase() === handle.toLowerCase());

const definesIn = (row: SpineLedgerRow, beat: ScriptBeat): boolean => row.definedIn === beat.chapter || row.definedIn === beat.id;

const chapterNames = (script: ScriptV1, chapter: string): Set<string> =>
  new Set(script.beats.filter((b) => b.chapter === chapter).flatMap((b) => b.new_terms.map((t) => t.toLowerCase())));

/**
 * Stamps `new_terms` on the first beat that speaks each ledger handle, when the ledger defines the item in that beat's
 * chapter and the model left it out. The model does not fill `new_terms` for ledger handles, and Q-E19 reads it. An
 * item first spoken before its defining chapter is left alone: that is a real Q-E17 failure, not a missing label.
 * A stamp never adds an error row: a handle the glossary lacks is skipped (Q-E4), and a beat or chapter that already
 * holds its limit of terms takes no more (Q-F8, Q-E4).
 */
export function stampLedgerTerms(script: ScriptV1, spine: SpineV1): Stamped {
  const glossary = new Set(script.video.glossary.map((entry) => entry.name.toLowerCase()));
  const stamps: LedgerStamp[] = [];
  const added = new Map<string, string[]>();
  const named = new Map<string, Set<string>>();
  for (const row of spine.ledger) {
    const first = script.beats.find((beat) => names(beat.spoken, row.item));
    if (!first || !definesIn(row, first) || declares(first, row.item) || !glossary.has(row.item.toLowerCase())) continue;
    const chapter = named.get(first.chapter) ?? chapterNames(script, first.chapter);
    const taken = [...first.new_terms, ...(added.get(first.id) ?? [])];
    if (taken.length >= MAX_TERMS_PER_BEAT || (!chapter.has(row.item.toLowerCase()) && chapter.size >= MAX_NEW_NAMES_PER_CHAPTER)) continue;
    named.set(first.chapter, chapter.add(row.item.toLowerCase()));
    added.set(first.id, [...(added.get(first.id) ?? []), row.item]);
    stamps.push({ beat: first.id, term: row.item });
  }
  if (stamps.length === 0) return { script, stamps };
  const beats = script.beats.map((beat) => (added.has(beat.id) ? { ...beat, new_terms: [...beat.new_terms, ...added.get(beat.id)!] } : beat));
  return { script: { ...script, beats }, stamps };
}
