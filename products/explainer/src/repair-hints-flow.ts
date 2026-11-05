import type { L0Result } from "./eval-l0.js";
import { MAX_NEW_NAMES_PER_CHAPTER } from "./lint-evidence.js";
import { BEAT_SECONDS, MAX_BEAT_NEW_NAMES, MAX_LIST_ITEMS, MAX_OUTRO_WORDS, MIN_HANDOFFS } from "./lint-flow.js";
import { DENSE_ITEM_COUNT, MAX_NEW_ITEMS_PER_BEAT, MIN_DIGEST_GAP_S } from "./lint-pace.js";
import { wordsOf } from "./lint-text.js";
import { fromScriptV1, type PaceBeat } from "./pace-items.js";
import { listed, namedBeats, namedChapters, percent, quoted, type Hint } from "./repair-hint.js";
import type { ScriptV1 } from "./script-schema.js";

function overloadHint(script: ScriptV1, row: L0Result): string {
  const [min, max] = BEAT_SECONDS;
  return namedBeats(script, row).map((beat) => {
    const faults = [
      ...(beat.new_terms.length > MAX_BEAT_NEW_NAMES ? [`names ${beat.new_terms.length} new terms (at most ${MAX_BEAT_NEW_NAMES})`] : []),
      ...(beat.plannedS < min || beat.plannedS > max ? [`plans ${beat.plannedS} s (${min}-${max} s)`] : []),
    ];
    return `${beat.id} ${faults.join(" and ")}`;
  }).join("; ") + "; split each into continuation beats of one idea, or move names to the next beat";
}

function closeHint(script: ScriptV1, row: L0Result): string {
  const outro = script.beats.at(-1);
  const words = outro ? wordsOf(outro.spoken).length : 0;
  const long = outro && words > MAX_OUTRO_WORDS ? `; the last beat ${outro.id} says ${words} words (at most ${MAX_OUTRO_WORDS})` : "";
  return `${listed(row.detail_beats)}: the close needs video.close_type and a CLOSE beat, with no recap ("to recap", "in summary", "we saw") and no list of 3 or more, and never "start reading"${long}`;
}

function glossaryHint(script: ScriptV1, row: L0Result): string {
  const glossary = new Set(script.video.glossary.map((entry) => entry.name.toLowerCase()));
  const unglossed = namedBeats(script, row).flatMap((b) => b.new_terms.filter((t) => !glossary.has(t.toLowerCase())).map((t) => `${b.id} "${t}"`));
  const parts = unglossed.length ? [`new_terms missing from video.glossary: ${unglossed.join(", ")}; add a glossary entry for each, or drop the term`] : [];
  parts.push(`a chapter may name at most ${MAX_NEW_NAMES_PER_CHAPTER} new terms`);
  return parts.join("; ");
}

function paceBeats(script: ScriptV1): PaceBeat[] {
  try {
    return fromScriptV1(script);
  } catch {
    return [];
  }
}

function crowdHint(script: ScriptV1, row: L0Result): string {
  const named = paceBeats(script).filter((b) => row.detail_beats.includes(b.id)).map((b) => `${b.id} shows ${b.newItems.length} (${quoted(b.newItems.map((i) => i.label))})`);
  return `new on-screen items past ${MAX_NEW_ITEMS_PER_BEAT} a beat: ${named.join("; ")}; move some to the next beat, or drop the labels, pins or cues that add them`;
}

function seatHint(script: ScriptV1, row: L0Result): string {
  const spineRows = row.detail_beats.filter((id) => id.startsWith("§"));
  const video = row.detail_beats.filter((id) => !id.startsWith("§"));
  const parts = video.length ? [`video.invariants ${quoted(video)} have no seat in the spine's architecture; drop them from video.invariants, or reword each to match a seated invariant`] : [];
  if (spineRows.length) parts.push(`spine rows ${listed(spineRows)} are the spine's to fix; leave the script as planned for them`);
  return parts.join("; ");
}

/** The flow, evidence, pace, ledger and spine rules without a hint of their own module. */
export const FLOW_HINTS: Readonly<Record<string, Hint>> = {
  "Q-F2": (_script, row) =>
    `${percent(row.value)} of chapter hand-offs hold (needs ${percent(MIN_HANDOFFS)}); dropped into ${listed(row.detail_beats)}. Set connector_in on each, or end the beat before it on a question or a but/so/therefore turn that shares a word with it`,
  "Q-F7": (script, row) => `the questions of chapters ${listed(namedChapters(script, row))} are not why, how or about the viewer; start each with "Why", "How does" or "How can", or ask what "you" get`,
  "Q-F8": overloadHint,
  "Q-F9": (_script, row) =>
    `${listed(row.detail_beats)} speak a list of more than ${MAX_LIST_ITEMS} items, or read 3 or more names or paths aloud; shorten the list, or show the names as labels and say what they share`,
  "Q-F10": (_script, row) => `SIGN or VERDICT beats ${listed(row.detail_beats)} interrupt a WHAT/HOW run inside a chapter; move each after the run`,
  "Q-F11": closeHint,
  "Q-E1": (_script, row) => `${listed(row.detail_beats)} make claims with empty fact_ids, or show a verified or computed chip with no fact_id; cite the fact for each`,
  "Q-E2": () => "running_example has no fact_ids; cite the fact its scenario comes from",
  "Q-E3": (_script, row) => `the repo-tour-public profile allows no VERDICT beat: ${listed(row.detail_beats)}; give each another function`,
  "Q-E4": glossaryHint,
  "Q-E7": crowdHint,
  "Q-E9": (_script, row) =>
    `dense beats ${listed(row.detail_beats)} (${DENSE_ITEM_COUNT} or more new items) sit within ${MIN_DIGEST_GAP_S} s of each other; thin one to fewer items, or put ${MIN_DIGEST_GAP_S} s of plain beats between them`,
  "Q-E11": (_script, row) => `${listed(row.detail_beats)} state an invariant with no map on screen, or state more than one; add a map_state to the beat, or keep one invariant`,
  "Q-E15": (_script, row) => `the spine puts ${listed(row.detail_beats)} out of journey order or without a why; the spine is fixed input, so keep the planned chapter order`,
  "Q-E16": (_script, row) => `list beats ${listed(row.detail_beats)} mix ledger items of more than one kind; keep each list to one kind, or split it`,
  "Q-E18": seatHint,
};
