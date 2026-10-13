import { runL0, type L0Result } from "./eval-l0.js";
import { flowCheck } from "./lint-flow.js";
import { voiceCheck } from "./lint-voice.js";
import { ScriptSchema, type ScriptV1 } from "./script-schema.js";

export type BeatSpec = [id: string, chapter: string, fn: string, spoken: string, extra?: Record<string, unknown>];

export const beat = ([id, chapter, fn, spoken, extra = {}]: BeatSpec) => ({
  id,
  chapter,
  function: fn,
  mode: "explain",
  plannedS: 10,
  spoken,
  fact_ids: [],
  visual: { assertion: "The desk refuses unknown parcels", job: "numbers" },
  ...extra,
});

export const THESIS = "the desk checks every scan against the ledger before printing";

// A synthetic tour of an invented repo that every voice and flow lint passes: the positive control.
export const GOOD_BEATS: BeatSpec[] = [
  ["h1", "ch1", "HOOK", "A courier asks for a label on a parcel that never arrived, but the desk refuses."],
  ["h2", "ch1", "STAKE", "That refusal works because the desk checks every scan against the ledger before printing."],
  ["w1", "ch2", "WHAT", "So every scan enters through the scanner app, which sends it to the desk server.", { connector_in: "so" }],
  ["w2", "ch2", "WHAT", "The desk server holds each scan until the ledger confirms the parcel, so nothing prints early."],
  ["w3", "ch2", "WHAT", "But the ledger can be slow, so the desk waits rather than guess."],
  ["w4", "ch2", "WHAT", "That is what it does. Now, how does the desk know a parcel is real?"],
  ["k1", "ch3", "HOW", "The ledger keeps one row per parcel, therefore the desk asks for that row first.", { connector_in: "therefore" }],
  ["k2", "ch3", "HOW", "If the row is missing, the desk refuses the label, so the courier sees the refusal at once."],
  ["k3", "ch3", "HOW", "But is a refusal an error? No, because the parcel may still be on its way."],
  ["c1", "ch4", "CLOSE", "So the desk checks every scan against the ledger before printing, and your parcel stays real.", { connector_in: "so" }],
  ["c2", "ch4", "CLOSE", "Check the row, then print.", { plannedS: 6 }],
];

const CHAPTERS = [
  ["ch1", "Why would a desk refuse a label?"],
  ["ch2", "How does a scan reach the ledger?"],
  ["ch3", "How does the desk know a parcel is real?"],
  ["ch4", "Why does that refusal matter to you?"],
].map(([id, question]) => ({ id, label: `${id} · ${question}`, question }));

export function tour(beats: BeatSpec[] = GOOD_BEATS, video: Record<string, unknown> = {}, chapters = CHAPTERS): ScriptV1 {
  return ScriptSchema.parse({
    schema: "script/v1",
    id: "parcel-desk-v1",
    profile: "repo-tour",
    facts_pack: "facts.tsv",
    video: {
      audience: "TODO: audience",
      stake: "TODO: stake",
      promise: "You can tell which scans the desk trusts",
      thesis_mechanism: THESIS,
      thesis_refs: ["h1", "w4", "c1"],
      running_example: "TODO: example",
      simplifications: [],
      close_type: "callback",
      ...video,
    },
    chapters,
    beats: beats.map(beat),
  });
}

/** Swaps one beat's fields in the positive control. */
export const withBeat = (id: string, patch: Partial<{ fn: string; spoken: string; extra: Record<string, unknown> }>): BeatSpec[] =>
  GOOD_BEATS.map((spec) => {
    if (spec[0] !== id) return spec;
    const [, chapter, fn, spoken, extra] = spec;
    return [id, chapter, patch.fn ?? fn, patch.spoken ?? spoken, { ...extra, ...patch.extra }];
  });

export function lint(script: ScriptV1, checks = [voiceCheck, flowCheck]): Map<string, L0Result> {
  return new Map(runL0(script, undefined, checks).map((row) => [row.check_id, row]));
}
