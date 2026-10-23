import { ODD_ONE_OUT_MIN_ITEMS } from "./eval-cold.js";
import type { L0Check, L0Result } from "./eval-l0.js";
import { ruleRow } from "./lint-text.js";
import type { ScriptV1 } from "./script-schema.js";
import { fromScriptV1, labelKey, type PaceBeat, type PaceItem } from "./pace-items.js";
import { contrastBeats, type SpineLedgerRow, type SpineV1 } from "./spine-schema.js";

/** Script profiles planned against a story spine; a script on one of them fails Q-E17 when it ships without one. */
export const SPINE_PROFILES: ReadonlySet<string> = new Set(["design-explainer"]);

type Ledger = ReadonlyMap<string, SpineLedgerRow>;

const ledgerOf = (spine: SpineV1): Ledger => new Map(spine.ledger.map((row) => [labelKey(row.item), row]));
const entryOf = (ledger: Ledger, item: PaceItem): SpineLedgerRow | undefined => ledger.get(labelKey(item.label));

/** Q-E17: beats that put a new item on screen the ledger does not list. */
function unledgered(beats: readonly PaceBeat[], ledger: Ledger): string[] {
  return beats.filter((beat) => beat.newItems.some((item) => !entryOf(ledger, item))).map((b) => b.id);
}

// A spine written before the beats (an audition pick) can only name the chapter an item is defined in; that
// chapter's first beat stands for it. A beat id wins over a chapter of the same name.
function positions(beats: readonly PaceBeat[]): Map<string, number> {
  const position = new Map(beats.map((b, i) => [b.id, i]));
  beats.forEach((b, i) => {
    if (!position.has(b.chapter)) position.set(b.chapter, i);
  });
  return position;
}

/**
 * Q-E17: beats that first show an item whose defining beat (or chapter) comes later, or is not in the script. Beats
 * are compared by script position, never by id: as text "r10-1" sorts before "r2-1".
 */
function definedLate(beats: readonly PaceBeat[], ledger: Ledger): string[] {
  const position = positions(beats);
  return beats
    .filter((beat, at) =>
      beat.newItems.some((item) => {
        const entry = entryOf(ledger, item);
        if (!entry) return false;
        const defined = position.get(entry.definedIn);
        return defined === undefined || defined > at;
      }),
    )
    .map((b) => b.id);
}

// A list is what the cues put on screen as entries. Map reveals, pins and spoken terms share the beat but are not
// entries of its list, and attributes and actions qualify an entry rather than add one.
const listEntries = (beat: PaceBeat): PaceItem[] => beat.items.filter((i) => i.source === "cue" && i.role === "item");

/**
 * Q-E16 (M6): parallel list beats whose ledgered entries carry more than one declared kind. Unledgered entries are
 * Q-E17's. A list is the item judge's cut, so a pair (a stat and its target) is not one, and a `contrast` beat mixes
 * kinds by design.
 */
function mixedLists(beats: readonly PaceBeat[], ledger: Ledger, contrast: ReadonlySet<string>): string[] {
  return beats
    .filter((beat) => {
      if (contrast.has(beat.id)) return false;
      const entries = listEntries(beat);
      const kinds = new Set(entries.flatMap((item) => entryOf(ledger, item)?.kind ?? []));
      return entries.length >= ODD_ONE_OUT_MIN_ITEMS && kinds.size > 1;
    })
    .map((b) => b.id);
}

const quoted = (labels: readonly string[]): string => labels.map((label) => `"${label}"`).join(", ");

/** What one failing beat shows that Q-E17 rejects: items the ledger does not list, and items it defines later. */
function beatFindings(beat: PaceBeat, at: number, beats: readonly PaceBeat[], ledger: Ledger): string[] {
  const position = positions(beats);
  const available = [...ledger.values()].filter((entry) => (position.get(entry.definedIn) ?? Infinity) <= at).map((entry) => entry.item);
  const unlisted = beat.newItems.filter((item) => !entryOf(ledger, item));
  const late = beat.newItems.flatMap((item) => {
    const entry = entryOf(ledger, item);
    return entry && (position.get(entry.definedIn) ?? Infinity) > at ? [{ item, entry }] : [];
  });
  const found: string[] = [];
  if (unlisted.length > 0) {
    const handles = available.length > 0 ? quoted(available) : "none yet";
    found.push(`${beat.id} shows ${quoted(unlisted.map((i) => i.label))} (${[...new Set(unlisted.map((i) => i.source))].join("/")}), not in the spine ledger; name a ledger item the chapter may use (${handles}) or drop it`);
  }
  late.forEach(({ item, entry }) => found.push(`${beat.id} shows "${item.label}" before ${entry.definedIn}, where the ledger defines it; move it to ${entry.definedIn} or drop it`));
  return found;
}

/** The repair hint for a failing Q-E17 row: each offending item, its beat, and the ledger handles that beat may use. */
export function ledgerHint(script: ScriptV1, failing: readonly string[], spine: SpineV1): string | undefined {
  let beats: PaceBeat[];
  try {
    beats = fromScriptV1(script);
  } catch {
    return undefined;
  }
  const ledger = ledgerOf(spine);
  const named = new Set(failing);
  const found = beats.flatMap((beat, at) => (named.has(beat.id) ? beatFindings(beat, at, beats, ledger) : []));
  return found.length > 0 ? found.join("; ") : undefined;
}

const row = (check_id: string, beats: readonly string[], pass = beats.length === 0): L0Result =>
  ruleRow(check_id, { value: beats.length, threshold: 0, pass, beats, mode: "tagged", severity: "error" });

// With no spine there is no ledger, so every new item is unlisted. Only a profile that plans against a spine
// fails for that; for any other the rules have nothing to read and pass.
function spinelessRows(beats: readonly PaceBeat[], required: boolean): L0Result[] {
  const named = required ? beats.filter((b) => b.newItems.length > 0).map((b) => b.id) : [];
  return [row("Q-E16", []), row("Q-E17", named, !required)];
}

/** The spine ledger lints over an item track: Q-E16 (M6, one kind a list) and Q-E17 (ledgered, defined before use). */
export function ledgerRows(beats: readonly PaceBeat[], spine: SpineV1 | undefined, required = false): L0Result[] {
  if (!spine) return spinelessRows(beats, required);
  const ledger = ledgerOf(spine);
  const failing = new Set([...unledgered(beats, ledger), ...definedLate(beats, ledger)]);
  return [row("Q-E16", mixedLists(beats, ledger, contrastBeats(spine))), row("Q-E17", beats.filter((b) => failing.has(b.id)).map((b) => b.id))];
}

/** The ledger lints on a script/v1. A script the item track cannot project fails both rows on every beat. */
export const ledgerCheck: L0Check = ({ script, timing, spine }) => {
  let beats: PaceBeat[];
  try {
    beats = fromScriptV1(script, timing);
  } catch {
    const all = script.beats.map((b) => b.id);
    return [row("Q-E16", all), row("Q-E17", all)];
  }
  return ledgerRows(beats, spine, SPINE_PROFILES.has(script.profile));
};
