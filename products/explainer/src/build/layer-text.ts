import type { Finding, HeldFinding, ProbedMoment } from "@titan-design/render-qa";
import { contentFill, MIN_CONTENT_FILL } from "../content-fill.js";
import { cueResolverFromWords } from "../cues.js";
import { FRAME_WORDS, frameWords } from "../qa/timing-gates.js";
import type { BuilderRef } from "./beat-worker.js";
import { FULL_COLOUR_RULE } from "./layer-fade.js";
import type { LayerPacket } from "./layer-packet.js";
import type { BuiltLayer } from "./layer-tree.js";

/** qa's own finding kinds the build check holds a layer to, then the text no frame may show. */
export const QA_TEXT_RULES = ["small-text", "under-chrome"] as const;
/** qa's narration rules on a layer's text: narration-facts on its settled numbers and names, G10 on every text. */
export type LayerNarrationRule = "unspoken-fact" | "narration-echo";
/** qa's frame-wide gates on a layer: content-fill on its settled frame, words-per-frame on every probed frame. */
export type LayerFrameRule = "content-fill" | "words-per-frame";
export type LayerTextRule = (typeof QA_TEXT_RULES)[number] | "low-contrast" | "off-frame" | "bad-text" | LayerNarrationRule | LayerFrameRule;

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

/** The colours and ratios qa's low-contrast rule measured, when the finding carries them all. */
function contrastOf({ ratio, need, fg, bg }: Finding): LayerContrast | undefined {
  return ratio === undefined || need === undefined || fg === undefined || bg === undefined ? undefined : { ratio, need, colour: fg, ground: bg };
}

/** qa's small-text and under-chrome findings at one moment, as rows. */
export const qaRows = (beat: string, atS: number, findings: readonly Finding[]): LayerTextRow[] =>
  findings.flatMap(({ kind, el, text }) => (isQaTextRule(kind) ? [{ beat, element: el, rule: kind, text: text ?? "", atS }] : []));

/** The low-contrast and off-frame findings qa holds, as rows first seen at the finding's first sample. */
export const heldRows = (held: readonly HeldFinding[]): LayerTextRow[] =>
  held.flatMap(({ kind, beat, finding, ts }): LayerTextRow[] => {
    const row = { beat, element: finding.el, text: finding.text ?? "", atS: ts[0] ?? 0 };
    if (kind === "off-frame") return [{ ...row, rule: "off-frame" }];
    if (kind !== "low-contrast") return [];
    const contrast = contrastOf(finding);
    return [{ ...row, rule: "low-contrast", ...(contrast ? { contrast } : {}) }];
  });

/** Every visible text run that shows `NaN`, `undefined`, `null` or `[object`, as rows. */
export const badTextRows = (beat: string, probed: readonly Pick<ProbedMoment, "t" | "texts">[]): LayerTextRow[] =>
  probed.flatMap(({ t, texts }) => texts.filter(({ text }) => BAD_TEXT.test(text)).map(({ element, text }) => ({ beat, element, rule: "bad-text" as const, text, atS: t })));

/** qa's content-fill gate on the layer's settled frame: its content spans under 60 % of the frame width. */
export function contentFillRows(beat: string, settled: Pick<ProbedMoment, "t" | "boxes">, frame: { width: number; height: number }): LayerTextRow[] {
  const fill = contentFill({ beat, t: settled.t, boxes: settled.boxes }, frame);
  return fill >= MIN_CONTENT_FILL ? [] : [{ beat, element: "stage", rule: "content-fill", text: `${Math.round(fill * 100)} % of the frame width`, atS: settled.t }];
}

/** qa's words-per-frame gate on every probed frame of the layer, as one row at the frame with the most words. */
export function frameWordRows(beat: string, probed: readonly Pick<ProbedMoment, "t" | "texts">[]): LayerTextRow[] {
  const counts = probed.map(({ t, texts }) => ({ t, n: frameWords(texts) })).filter(({ n }) => n > FRAME_WORDS);
  const most = counts.reduce<(typeof counts)[number] | undefined>((top, count) => (top === undefined || count.n > top.n ? count : top), undefined);
  return most ? [{ beat, element: "frame", rule: "words-per-frame", text: `${most.n} words on screen`, atS: most.t }] : [];
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
  "low-contrast":
    "text on a filled shape uses that fill's on- text token, as var(--color-on-brand-primary) on var(--color-brand-primary-solid), or use a darker fill",
  "off-frame": "keep every painted part inside the 1920 by 1080 frame; an element waiting for its cue is clipped away whole, as clipPath inset(0 100% 0 0)",
  "bad-text": "draw a real value: read the clock as const { t } = useBeatTime(), and format every number before it is shown",
  "unspoken-fact": "draw no number or name the narration does not say; drop it or show only what is spoken",
  "narration-echo": "show key words, not the sentence: share fewer than 5 words in a row with the narration",
  "content-fill": "spread the settled content across at least 60 % of the frame width, with shapes painted in defined theme tokens",
  "words-per-frame": "show at most 20 words on screen at once: keep key nouns and numbers, drop the rest",
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
