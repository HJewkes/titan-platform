import { migrateTourV0 } from "./migrate.js";
import { ScriptSchema, type ScriptV1 } from "./script-schema.js";

// Synthetic scripts about an invented repo, parcel-desk. Neither is a real tour.

const beat = (id: string, chapter: string, fn: string, spoken: string, extra: Record<string, unknown> = {}) => ({
  id,
  chapter,
  function: fn,
  mode: "explain",
  plannedS: 10,
  spoken,
  fact_ids: [],
  visual: { assertion: "The desk refuses a stale label", job: "artifact-filling" },
  ...extra,
});

const why = (fact: string) => ({ need: "a courier needs the right shelf", actor: "courier", consequence: "a parcel waits a day", fact_ids: [fact] });
const value = (fact: string) => ({ text: "you never reprint a label", fact_ids: [fact] });

const GOOD_VIDEO = {
  audience: { persona: "a maintainer", proximity: "outsider", gloss: "engineer" },
  stake: { who: "courier", loses_what: "a day per parcel", number: "300 a week", fact_ids: ["F2"] },
  promise: "You will catch a bad label before it prints.",
  thesis_mechanism: "parcel-desk works by checking the ledger before printing",
  running_example: { scenario: "A courier scans parcel P-7.", anchor: "parcel P-7", fact_ids: ["F1"] },
  simplifications: ["customs holds are skipped"],
  glossary: [{ name: "desk server", job: "checks labels" }],
  close_type: "callback",
};

const GOOD_CHAPTERS = [
  { id: "ch1", label: "Hook · Why refuse a label?", question: "Why refuse a label?" },
  { id: "ch2", label: "Desk · Why does the desk sit in the middle?", question: "Why does the desk sit in the middle?" },
  { id: "ch3", label: "Check · How come a stale label never prints?", question: "How come a stale label never prints?" },
  { id: "ch4", label: "Limits · Why trust the check?", question: "Why trust the check?" },
  { id: "ch5", label: "Close · What changed?", question: "What changed?" },
];

const GOOD_BEATS = [
  beat("b1", "ch1", "HOOK", "A courier scans parcel P-7 and the desk refuses its label.", { fact_ids: ["F1"] }),
  beat("b2", "ch1", "STAKE", "You lose a day for every wrong label, three hundred a week.", { fact_ids: ["F2"] }),
  beat("b3", "ch1", "PROMISE", "You will see the desk catch a bad label before it prints."),
  beat("b4", "ch1", "FENCE", "Other desks check after printing; this one checks before.", {
    fact_ids: ["F3"],
    visual: { assertion: "Ours checks before printing", job: "alternatives-vs-ours" },
  }),
  beat("b5", "ch2", "WHAT", "Without it, parcel P-7 would print a label for a shelf that is gone.", {
    fact_ids: ["F4"],
    why: why("F4"),
    user_value: value("F4"),
    new_terms: ["desk server"],
  }),
  beat("b6", "ch3", "HOW", "The desk server reads parcel P-7 from the ledger. A label never prints without a ledger row.", {
    fact_ids: ["F5"],
    why: why("F5"),
    user_value: value("F5"),
  }),
  beat("b7", "ch3", "HOW", "Run scan on parcel P-7 and the desk answers refused.", {
    mode: "demo",
    fact_ids: ["F5"],
    visual: { assertion: "The scan answers refused", job: "code-proof", cues: [{ action: "V6", target: "term", atCue: "scan" }] },
  }),
  beat("b8", "ch3", "HISTORY", "Parcel P-7 once printed twice, so the batch path was removed.", {
    fact_ids: ["F6"],
    design_history: { tried: "a batch path", failed_because: "double prints", changed_to: "one check", source_sha: "a1b2c3d" },
  }),
  beat("b9", "ch4", "CAVEAT", "This view skips customs holds.", { fact_ids: ["F7"], user_value: value("F7") }),
  beat("b10", "ch5", "CLOSE", "So parcel P-7 never got its wrong label."),
];

/** A script that follows the template: stake early, why before how, one walked example, limits before the close. */
export function goodScript(): ScriptV1 {
  const head = { schema: "script/v1", id: "parcel-desk-good", profile: "repo-tour", facts_pack: "facts.tsv" };
  return ScriptSchema.parse({ ...head, video: GOOD_VIDEO, chapters: GOOD_CHAPTERS, beats: GOOD_BEATS });
}

const open = (n: number, question: string) => ({ id: `c${n}-1-open`, chapter: `ch${n}`, kind: "chapter-open", plannedS: 4, spoken: `Chapter ${n}. ${question}` });
const spike = (id: string, kind: string, spoken: string) => ({ id, chapter: `ch${id[1]}`, kind, plannedS: 10, spoken });

const CHAPTERS: [string, string][] = [
  ["Cold open", "Why refuse its own label?"],
  ["Purpose", "Who is it for?"],
  ["Entry points", "Where does it start?"],
  ["Parts", "Which part matters?"],
  ["Walk one print", "One print, end to end"],
  ["Shelf checks", "How does it stop a label for a missing shelf?"],
  ["Scorecard", "What do we take?"],
];

/**
 * Shaped like the spike's pass A: its hook prints one label range, its walk follows another, and
 * only the purpose chapter leads with a problem. Label and shelf words recur in nearly every chapter.
 */
export const passALikeTour = {
  title: "parcel-desk, a repo tour",
  chapters: CHAPTERS.map(([title, question], i) => ({ id: `ch${i + 1}`, title, question })),
  beats: [
    spike("c1-1-hook", "hook", "A courier prints label forty to forty-eight for a shelf of thirty-five. The desk refuses the label."),
    spike("c1-2-what", "title", "This is parcel-desk: a desk server that checks every shelf label."),
    open(2, "Who is it for?"),
    spike("c2-2-context", "station-map", "Its makers name two problems: labels drift, and couriers cannot see which shelf moved."),
    open(3, "Where does it start?"),
    spike("c3-2-cli", "terminal", "Everything ships as one command line tool for label printing."),
    spike("c3-3-call", "terminal", "Here is the call we will follow. The courier prints label ten to twenty for one shelf."),
    open(4, "Which part matters?"),
    spike("c4-2-parts", "station-map", "Five parts. The scanner talks to the desk server, which owns each shelf label."),
    open(5, "One print, end to end"),
    spike("c5-2-walk", "arch-map", "Follow the call. The desk reads label ten to twenty from the ledger and checks the shelf."),
    spike("c5-3-save", "arch-map", "Then it saves the label and the shelf screen redraws."),
    open(6, "How does it stop a label for a missing shelf?"),
    spike("c6-2-grammar", "code-walk", "A label names a shelf and a range of lines."),
    spike("c6-3-check", "code-walk", "Here is the check. It reads each label range from the shelf."),
    open(7, "What do we take?"),
    spike("c7-2-scorecard", "scorecard", "Adopt the shelf check on every label."),
    spike("c7-3-outro", "outro", "Thanks for watching."),
  ],
};

/** Pass-A-like script migrated to script/v1, with its running example authored as `anchor`. */
export function passALike(anchor?: string): ScriptV1 {
  const script = migrateTourV0(passALikeTour, { beats: [] });
  if (!anchor) return script;
  const running_example = { scenario: "A courier prints one label.", anchor, fact_ids: ["F1"] };
  return { ...script, video: { ...script.video, running_example } };
}
