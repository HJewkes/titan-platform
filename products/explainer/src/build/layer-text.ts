import type { ERROR_KINDS, Finding, HeldFinding, ProbedMoment } from "@titan-design/render-qa";
import { cueResolverFromWords } from "../cues.js";
import { DEFAULT_PADDING, trueDuration } from "../workflow/tts-truing.js";
import type { BuilderRef } from "./beat-worker.js";
import { FULL_COLOUR_RULE } from "./layer-fade.js";
import type { LayerPacket } from "./layer-packet.js";
import type { BuiltLayer } from "./layer-tree.js";

/** qa's own finding kinds the build check holds a layer to at every reveal, on one sample. */
export const QA_TEXT_RULES = ["small-text", "under-chrome"] as const;
/** Every kind qa's gate can hold, which the build check holds over qa's own samples (`LAYER_HELD_KINDS`). */
export type LayerHeldRule = (typeof ERROR_KINDS)[number];
/** qa's narration rules on a layer's text: narration-facts on its settled numbers and names, G10 on every text. */
export type LayerNarrationRule = "unspoken-fact" | "narration-echo";
/** qa's frame-wide gates on a layer: content-fill on its settled frame, words-per-frame on every probed frame. */
export type LayerFrameRule = "content-fill" | "words-per-frame";
/** A cue word whose frames do not change the picture, which Q-D22 counted as a change (TP-4596). */
export type LayerCueRule = "still-cue";
/** qa's beat-local timing gates a layer can fail, which the build check runs over the layer's own frames. */
export type LayerTimingRule = "picture-change" | "static-window" | "reading-hold" | "G9";
export type LayerTextRule = LayerHeldRule | "bad-text" | LayerNarrationRule | LayerFrameRule | LayerCueRule | LayerTimingRule;

/** One element of one layer that breaks a rule, first seen `atS` seconds into the beat. */
export interface LayerTextRow {
  beat: string;
  element: string;
  rule: LayerTextRule;
  text: string;
  atS: number;
  /** The number or name an unspoken-fact row shows that the narration never says. */
  fact?: string;
  /** A low-contrast row's measured ratio, the ratio its size needs, and its text and ground colours as drawn. */
  contrast?: LayerContrast;
}

export interface LayerContrast {
  ratio: number;
  need: number;
  colour: string;
  ground: string;
}

export interface LayerCheckInput {
  builder: BuilderRef;
  layer: BuiltLayer;
  packet: Pick<LayerPacket, "beat_id" | "spoken" | "cues" | "planned_s" | "band">;
}

/** Renders one built layer at its reveal points and returns every element that breaks a rule; empty when it passes. */
export type LayerTextCheck = (input: LayerCheckInput) => Promise<LayerTextRow[]>;

/** Text a value left unformatted: a failed sum, a missing field, an object printed whole. */
const BAD_TEXT = /\bNaN\b|\bundefined\b|\bnull\b|\[object\b/;
/** How long after its cue word an element is read: the layer's entrance has landed by then. */
const SETTLE_S = 1;
/** The beat's last moment, every element landed. */
const SETTLED_BEFORE_END_S = 0.05;

/** The beat as the voice is expected to play it, on one clock: its cut, its cue words and its words. */
export interface VoicedBeat {
  durationS: number;
  cues: Record<string, number>;
  words: { word: string; startS: number }[];
}

/**
 * The beat at its band's voice rate and truing's length, since tts runs after resolve: no real word time exists yet, and
 * the stretch after a beat's last cue is what the plan's seconds misread. On a stored daily video the band rates came
 * within 3 % of the voice and truing is the code tts itself runs, so a still stretch here lands within a few tenths of qa's.
 */
export function voicedBeat(packet: LayerCheckInput["packet"], wordsPerMinute: number): VoicedBeat {
  const spoken = packet.spoken.split(/\s+/).filter((word) => word !== "");
  const speechS = (spoken.length * 60) / wordsPerMinute;
  const words = spoken.map((word, i) => ({ word, startS: DEFAULT_PADDING.leadS + (i * speechS) / spoken.length }));
  const resolve = cueResolverFromWords({ [packet.beat_id]: words });
  const cues = packet.cues.flatMap((cue) => [cue.atCue, ...(cue.untilCue ? [cue.untilCue] : [])]);
  const timed = Object.fromEntries(cues.flatMap((cue) => {
    try {
      return [[cue, resolve(packet.beat_id, cue)]];
    } catch {
      return [];
    }
  }));
  return { durationS: trueDuration(packet.planned_s, speechS, DEFAULT_PADDING, packet.band === "held"), cues: timed, words };
}

/** The still frames the check reads, in seconds from the beat start: each reveal once it settles, then the beat's end. */
export function revealMoments(cues: Readonly<Record<string, number>>, durationS: number): number[] {
  const end = Math.max(0, durationS - SETTLED_BEFORE_END_S);
  return [...new Set([...Object.values(cues).map((atS) => Math.min(atS + SETTLE_S, end)), end])].sort((a, b) => a - b);
}

const isQaTextRule = (kind: string): kind is (typeof QA_TEXT_RULES)[number] => QA_TEXT_RULES.some((rule) => rule === kind);

/**
 * What a rebuild does about each kind qa's gate can hold. Keyed by render-qa's own list, so a kind it adds fails the
 * type check here until the build check can tell a rebuild how to fix it.
 */
const HELD_FIX: Record<LayerHeldRule, string> = {
  "text-overlap": "give each text its own space: no two texts may overlap",
  "text-box": "keep text off every other element's box: move it or the box so they no longer overlap",
  "box-overlap": "lay boxes side by side or stacked with a gap: no box may overlap another it does not contain",
  occluded: "draw nothing over text: move the element that covers it, or the text",
  "edge-crossing": "route the line or arrow around the element it crosses, never through its text",
  "off-frame": "keep every painted part inside the 1920 by 1080 frame; an element waiting for its cue is clipped away whole, as clipPath inset(0 100% 0 0)",
  "content-overflow":
    "fit the content inside its box: no fixed height around text that can wrap, so let the panel grow with its content, or shorten the label so it fits on one line",
  "small-text": "draw it at 40 px or larger",
  "low-contrast":
    "text on a filled shape uses that fill's on- text token, as var(--color-on-brand-primary) on var(--color-brand-primary-solid), or use a darker fill",
  wrap: "keep the label on one line, or break it evenly: never leave one short word alone on its last line",
  "flex-wrap": "fit the row's items on one row: fewer or narrower items, or a wider row",
  "anchor-offset": "centre the element on its data-anchor-x and data-anchor-y point",
  "label-dropped": "leave room for every label: a label placement could not seat is never drawn",
  "edge-label-far": "place the edge's label within 60 px of its line",
  "late-fill": "show content early: the stage stays nearly empty well into the beat while cues are still to come",
  "double-chrome": "draw no title, caption or source band of your own: the page draws the beat's chrome",
  "under-chrome": "keep it inside the stage box, inset 0, without running past its edges",
  "fill-order": "fill cards in their reading order: no later card shows rows while an earlier one shows none",
  "tone-mismatch": "draw a problem state in a warning or danger token, never a success one",
  "title-repeat": "start no row with its card's title",
  "unlabelled-number": "give every number a word that says what it counts",
  "label-adjacent": "space separate labels apart so each reads as its own",
  misaligned: "set values meant to sit level at the same top",
};

/** The colours and ratios qa's low-contrast rule measured, when the finding carries them all. */
function contrastOf({ ratio, need, fg, bg }: Finding): LayerContrast | undefined {
  return ratio === undefined || need === undefined || fg === undefined || bg === undefined ? undefined : { ratio, need, colour: fg, ground: bg };
}

/** qa's small-text and under-chrome findings at one moment, as rows. */
export const qaRows = (beat: string, atS: number, findings: readonly Finding[]): LayerTextRow[] =>
  findings.flatMap(({ kind, el, text }) => (isQaTextRule(kind) ? [{ beat, element: el, rule: kind, text: text ?? "", atS }] : []));

const isHeldRule = (kind: string): kind is LayerHeldRule => Object.hasOwn(HELD_FIX, kind);

/** The findings qa holds, of every kind its gate can hold, as rows first seen at the finding's first sample. */
export const heldRows = (held: readonly HeldFinding[]): LayerTextRow[] =>
  held.flatMap(({ kind, beat, finding, ts }): LayerTextRow[] => {
    if (!isHeldRule(kind)) return [];
    const contrast = kind === "low-contrast" ? contrastOf(finding) : undefined;
    return [{ beat, element: finding.el, rule: kind, text: finding.text ?? "", atS: ts[0] ?? 0, ...(contrast ? { contrast } : {}) }];
  });

/** Every visible text run that shows `NaN`, `undefined`, `null` or `[object`, as rows. */
export const badTextRows = (beat: string, probed: readonly Pick<ProbedMoment, "t" | "texts">[]): LayerTextRow[] =>
  probed.flatMap(({ t, texts }) => texts.filter(({ text }) => BAD_TEXT.test(text)).map(({ element, text }) => ({ beat, element, rule: "bad-text" as const, text, atS: t })));

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
  ...HELD_FIX,
  "bad-text": "draw a real value: read the clock as const { t } = useBeatTime(), and format every number before it is shown",
  "unspoken-fact": "draw no number or name the narration does not say; drop it or show only what is spoken",
  "narration-echo": "show key words, not the sentence: share fewer than 5 words in a row with the narration",
  "content-fill": "spread the settled content across at least 60 % of the frame width, with shapes painted in defined theme tokens",
  "words-per-frame": "show at most 20 words on screen at once: keep key nouns and numbers, drop the rest",
  "still-cue":
    "change the picture on this cue word: an element already shown takes a highlight or pulse at full colour inside its own box, " +
    "never an opacity fade on text and never an outline or shadow outside the element's clip-path, which the clip cuts away",
  "static-window":
    "change the picture inside this still stretch: start a highlight or pulse at full colour inside an element's own box a few seconds after the last cue word before it, " +
    "as useCue(word) + 1.5, never a bare literal second. A frame may stand still past 3 s only after the last cue word, up to 6 s, with at most 3 s of it silent",
  "picture-change": "add a cue-driven change inside this stretch: a highlight or pulse timed from a cue word with useCue",
  "reading-hold": "leave this text on screen until it can be read, at 13 characters a second and at least 1.5 s, or show only words the narration says while it shows",
  G9: "cut it to at most 10 words in a headline and 3 in a label",
};

function ruleFix(row: LayerTextRow, fadedTexts: ReadonlySet<string>): string {
  if (row.fact !== undefined) return `the narration never says ${row.fact}: ${RULE_FIX[row.rule]}`;
  const { contrast } = row;
  if (contrast === undefined) return RULE_FIX[row.rule];
  const fade = fadedTexts.has(row.text) ? `; it is mid-fade, so ${FULL_COLOUR_RULE}` : "";
  return `${contrast.colour} on ${contrast.ground} is ${contrast.ratio}:1, under the ${contrast.need}:1 its size needs: ${RULE_FIX[row.rule]}${fade}`;
}

/**
 * What a rebuild is told about the elements the last build drew against qa's text rules, as a field of its packet.
 * `fadedTexts` are the texts the layer's source fades by opacity (TP-4527); a contrast row on one of them says so.
 */
export const layerTextHint = (rows: readonly LayerTextRow[], fadedTexts: ReadonlySet<string> = new Set()): string =>
  `the last build broke qa's text rules: ${rows.map((row) => `${row.rule} on ${row.element} ${JSON.stringify(row.text)} (${ruleFix(row, fadedTexts)})`).join("; ")}`;
