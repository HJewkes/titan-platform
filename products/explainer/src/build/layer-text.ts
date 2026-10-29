import type { Finding, ProbedMoment } from "@titan-design/render-qa";
import { plainText } from "@titan-design/speech-vet";
import { cueResolverFromWords } from "../cues.js";
import { unspokenFacts } from "../qa/narration-facts.js";
import { SHARED_RUN_WORDS, sharedRun } from "../qa/timing-gates.js";
import type { BuilderRef } from "./beat-worker.js";
import type { LayerPacket } from "./layer-packet.js";
import type { BuiltLayer } from "./layer-tree.js";

/** qa's own finding kinds the build check holds a layer to, then the text no frame may show. */
export const QA_TEXT_RULES = ["small-text", "under-chrome"] as const;
/** qa's narration rules on a layer's text: narration-facts on its settled numbers and names, G10 on every text. */
export type LayerNarrationRule = "unspoken-fact" | "narration-echo";
export type LayerTextRule = (typeof QA_TEXT_RULES)[number] | "bad-text" | LayerNarrationRule;

/** One element of one layer that breaks a rule, first seen `atS` seconds into the beat. */
export interface LayerTextRow {
  beat: string;
  element: string;
  rule: LayerTextRule;
  text: string;
  atS: number;
  /** The number or name an unspoken-fact row shows that the narration never says. */
  fact?: string;
}

export interface LayerCheckInput {
  builder: BuilderRef;
  layer: BuiltLayer;
  packet: Pick<LayerPacket, "beat_id" | "spoken" | "cues" | "planned_s">;
}

/** Renders one built layer at its reveal points and returns every element that breaks a rule; empty when it passes. */
export type LayerTextCheck = (input: LayerCheckInput) => Promise<LayerTextRow[]>;

/** Text a value left unformatted: a failed sum, a missing field, an object printed whole. */
const BAD_TEXT = /\bNaN\b|\bundefined\b|\bnull\b|\[object\b/;
/** How long after its cue word an element is read: the layer's entrance has landed by then. */
const SETTLE_S = 1;
/** The beat's last moment, every element landed. */
const SETTLED_BEFORE_END_S = 0.05;

/**
 * Where each cue word falls with the narration spread evenly over the beat's planned seconds: no words are spoken
 * before tts, and a layer times its entrances from the same plan.
 */
export function plannedCues(packet: LayerCheckInput["packet"]): Record<string, number> {
  const words = packet.spoken.split(/\s+/).filter((word) => word !== "");
  const resolve = cueResolverFromWords({ [packet.beat_id]: words.map((word, i) => ({ word, startS: (i * packet.planned_s) / words.length })) });
  const cues = packet.cues.flatMap((cue) => [cue.atCue, ...(cue.untilCue ? [cue.untilCue] : [])]);
  return Object.fromEntries(cues.flatMap((cue) => {
    try {
      return [[cue, resolve(packet.beat_id, cue)]];
    } catch {
      return [];
    }
  }));
}

/** The still frames the check reads, in seconds from the beat start: each reveal once it settles, then the beat's end. */
export function revealMoments(cues: Readonly<Record<string, number>>, durationS: number): number[] {
  const end = Math.max(0, durationS - SETTLED_BEFORE_END_S);
  return [...new Set([...Object.values(cues).map((atS) => Math.min(atS + SETTLE_S, end)), end])].sort((a, b) => a - b);
}

const isQaTextRule = (kind: string): kind is (typeof QA_TEXT_RULES)[number] => QA_TEXT_RULES.some((rule) => rule === kind);

/** qa's small-text and under-chrome findings at one moment, as rows. */
export const qaRows = (beat: string, atS: number, findings: readonly Finding[]): LayerTextRow[] =>
  findings.flatMap(({ kind, el, text }) => (isQaTextRule(kind) ? [{ beat, element: el, rule: kind, text: text ?? "", atS }] : []));

/** Every visible text run that shows `NaN`, `undefined`, `null` or `[object`, as rows. */
export const badTextRows = (beat: string, probed: readonly Pick<ProbedMoment, "t" | "texts">[]): LayerTextRow[] =>
  probed.flatMap(({ t, texts }) => texts.filter(({ text }) => BAD_TEXT.test(text)).map(({ element, text }) => ({ beat, element, rule: "bad-text" as const, text, atS: t })));

type ProbedTexts = Pick<ProbedMoment, "t" | "texts">;

/**
 * qa's narration rules on one layer, against the words its beat speaks: a number or headline name the settled frame
 * shows that the narration never says, read at the last moment so a count-up is judged on the value it lands on, and
 * any text that repeats 5 or more narration words in a row.
 */
export function narrationRows(beat: string, spoken: string, probed: readonly ProbedTexts[]): LayerTextRow[] {
  const heard = plainText(spoken);
  const settled = [...probed].sort((a, b) => a.t - b.t).at(-1);
  const facts = settled === undefined ? [] : unspokenFacts(beat, settled.texts, heard).map((fact): LayerTextRow => {
    const shown = settled.texts.find(({ text }) => text === fact.shown)!;
    return { beat, element: shown.element, rule: "unspoken-fact", text: shown.text, atS: settled.t, fact: fact.fact };
  });
  const echoes = probed.flatMap(({ t, texts }) => texts.filter(({ text }) => sharedRun(text, heard) >= SHARED_RUN_WORDS)
    .map(({ element, text }): LayerTextRow => ({ beat, element, rule: "narration-echo", text, atS: t })));
  return [...facts, ...echoes];
}

/** One row per element, rule, text and fact, the earliest moment kept. */
export function distinctRows(rows: readonly LayerTextRow[]): LayerTextRow[] {
  const first = new Map<string, LayerTextRow>();
  for (const row of [...rows].sort((a, b) => a.atS - b.atS)) {
    const key = `${row.element}\u0000${row.rule}\u0000${row.text}\u0000${row.fact ?? ""}`;
    if (!first.has(key)) first.set(key, row);
  }
  return [...first.values()];
}

export const formatLayerRow = ({ beat, element, rule, text, atS }: LayerTextRow): string =>
  `${beat} ${element} ${rule} ${JSON.stringify(text)} at ${atS.toFixed(2)} s`;

const RULE_FIX: Record<LayerTextRule, string> = {
  "small-text": "draw it at 40 px or larger",
  "under-chrome": "keep it inside the stage box, inset 0, without running past its edges",
  "bad-text": "draw a real value: read the clock as const { t } = useBeatTime(), and format every number before it is shown",
  "unspoken-fact": "draw no number or name the narration does not say; drop it or show only what is spoken",
  "narration-echo": "show key words, not the sentence: share fewer than 5 words in a row with the narration",
};

const ruleFix = (row: LayerTextRow): string => (row.fact === undefined ? RULE_FIX[row.rule] : `the narration never says ${row.fact}: ${RULE_FIX[row.rule]}`);

/** What a rebuild is told about the elements the last build drew against qa's text rules, as a field of its packet. */
export const layerTextHint = (rows: readonly LayerTextRow[]): string =>
  `the last build broke qa's text rules: ${rows.map((row) => `${row.rule} on ${row.element} ${JSON.stringify(row.text)} (${ruleFix(row)})`).join("; ")}`;
